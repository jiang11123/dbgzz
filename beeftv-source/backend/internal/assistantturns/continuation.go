package assistantturns

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

type ContinuationSubmission struct {
	OperationID   string   `json:"operationId"`
	OutputNodeIDs []string `json:"outputNodeIds"`
}
type ContinuationManifest struct {
	SourceNodeID string                   `json:"sourceNodeId"`
	Submissions  []ContinuationSubmission `json:"submissions"`
}
type ContinuationView struct {
	model.AssistantContinuation
	TaskIDs         []string `json:"taskIds"`
	SelectedNodeIDs []string `json:"nodeIds"`
	Message         string   `json:"message"`
}

const ContinuationMessage = "【自动继续】本次生成状态已更新。先读取画布核对原任务与实际结果，不把旧媒体当成本次产物。整片授权内的素材已由任务调度按就绪依赖推进；素材齐后直接完成声音、字幕、剪辑、成片和可编辑工程。成功绑定节点的durationMs是实际时长，顺序剪辑无需逐份审片，集中检查最终成片。失败或结果未知时检查并恢复原任务，不重复购买。新增或修改已确认的付费内容才重新确认。不要改动或发送我的未发送草稿。"

type ContinuationInput struct {
	CanvasID     string   `json:"canvasId"`
	SessionID    string   `json:"sessionId"`
	SourceTurnID string   `json:"sourceTurnId"`
	ProposalID   string   `json:"proposalId"`
	Kind         string   `json:"kind"`
	NodeIDs      []string `json:"nodeIds"`
}

func continuationError(reason string) error {
	return &Error{Reason: "continuation_" + reason, Message: "暂不能自动继续，请查看本次生成或手动继续"}
}
func continuationView(row model.AssistantContinuation) ContinuationView {
	ids := []string{}
	_ = json.Unmarshal([]byte(row.TaskIDsJSON), &ids)
	var manifests map[string]ContinuationManifest
	_ = json.Unmarshal([]byte(row.ManifestJSON), &manifests)
	selected := []string{}
	for _, manifest := range manifests {
		for _, submission := range manifest.Submissions {
			selected = append(selected, submission.OutputNodeIDs...)
		}
	}
	return ContinuationView{row, ids, uniqueSorted(selected), ContinuationMessage}
}

func (s *Service) ArmContinuation(userID string, input ContinuationInput) (*ContinuationView, error) {
	if len(input.NodeIDs) == 0 || len(input.NodeIDs) > 8 || (input.Kind != "image" && input.Kind != "video" && input.Kind != "audio") || !strings.HasPrefix(input.ProposalID, "gp-") {
		return nil, continuationError("invalid")
	}
	sum := sha256.Sum256([]byte(userID + "\x00" + input.SourceTurnID + "\x00" + input.ProposalID))
	id := hex.EncodeToString(sum[:24])
	var result model.AssistantContinuation
	err := s.store.DB().Transaction(func(tx *gorm.DB) error {
		source, err := s.load(tx, input.SourceTurnID)
		if err != nil {
			return err
		}
		if source.UserID != userID || source.CanvasID != input.CanvasID || source.DurableSessionID != input.SessionID || source.Undone || source.effectiveState() != StateSettled || Mode(source.PermissionMode) == PermissionReadOnly {
			return continuationError("scope_changed")
		}
		if source.ContinuationInvalidated {
			return continuationError("intent_changed")
		}
		context, err := s.getContext(tx, userID, input.CanvasID, input.SessionID)
		if err != nil {
			return err
		}
		if context.Lifecycle != "active" {
			return continuationError("scope_changed")
		}
		err = tx.First(&result, "id = ?", id).Error
		if err == nil {
			if result.SessionID != input.SessionID || result.Kind != input.Kind || result.SourceNodeIDs != encodeStringList(input.NodeIDs) {
				return continuationError("conflict")
			}
			if result.State == "cancelled" {
				return continuationError("cancelled")
			}
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		raw, err := s.canvas.BoundTo(tx).UserCanvasProject(userID, input.CanvasID)
		if err != nil {
			return err
		}
		var doc struct {
			Nodes []struct {
				ID   string `json:"id"`
				Type string `json:"type"`
			} `json:"nodes"`
		}
		if err = json.Unmarshal(raw, &doc); err != nil {
			return err
		}
		owned := map[string]string{}
		for _, n := range doc.Nodes {
			owned[n.ID] = n.Type
		}
		for _, id := range input.NodeIDs {
			if owned[id] != input.Kind {
				return continuationError("target_changed")
			}
		}
		result = model.AssistantContinuation{ID: id, UserID: userID, CanvasID: input.CanvasID, SessionID: input.SessionID, ScopeID: context.ScopeID, ScopeRevision: context.Revision, SourceTurnID: input.SourceTurnID, ProposalID: input.ProposalID, Kind: input.Kind, PermissionMode: source.PermissionMode, SourceNodeIDs: encodeStringList(input.NodeIDs), ManifestJSON: "{}", RequestID: "generation_" + id, TurnID: id, State: "waiting", Revision: 1, CreatedAt: s.now(), UpdatedAt: s.now()}
		return tx.Create(&result).Error
	})
	if err != nil {
		return nil, err
	}
	view := continuationView(result)
	return &view, nil
}

func (s *Service) continuationScope(tx *gorm.DB, row *model.AssistantContinuation) error {
	source, err := s.load(tx, row.SourceTurnID)
	if err != nil {
		return err
	}
	if source.Undone || source.DurableSessionID != row.SessionID {
		return continuationError("scope_changed")
	}
	ctx, err := s.getContext(tx, row.UserID, row.CanvasID, row.SessionID)
	if err != nil {
		return err
	}
	if ctx.ScopeID != row.ScopeID || ctx.Revision != row.ScopeRevision || ctx.Lifecycle != "active" {
		return continuationError("scope_changed")
	}
	if row.State == "cancelled" || row.State == "stopping" {
		return continuationError("cancelled")
	}
	return nil
}

func (s *Service) RegisterContinuationManifest(userID, id string, manifest ContinuationManifest) error {
	return s.store.DB().Transaction(func(tx *gorm.DB) error {
		var row model.AssistantContinuation
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, "id = ? AND user_id = ?", id, userID).Error; err != nil {
			return err
		}
		if err := s.continuationScope(tx, &row); err != nil {
			return err
		}
		var sources []string
		_ = json.Unmarshal([]byte(row.SourceNodeIDs), &sources)
		found := false
		for _, source := range sources {
			if source == manifest.SourceNodeID {
				found = true
			}
		}
		if !found || len(manifest.Submissions) == 0 || len(manifest.Submissions) > 8 {
			return continuationError("invalid")
		}
		prefix := "proposal:" + row.ProposalID + ":" + manifest.SourceNodeID
		seen := map[string]bool{}
		for i, submission := range manifest.Submissions {
			want := prefix
			if len(manifest.Submissions) > 1 {
				want = fmt.Sprintf("%s:%d", prefix, i)
			}
			if submission.OperationID != want || len(submission.OutputNodeIDs) == 0 || len(submission.OutputNodeIDs) > 8 {
				return continuationError("invalid")
			}
			for _, node := range submission.OutputNodeIDs {
				if strings.TrimSpace(node) == "" || seen[node] {
					return continuationError("invalid")
				}
				seen[node] = true
			}
		}
		var manifests map[string]ContinuationManifest
		if err := json.Unmarshal([]byte(row.ManifestJSON), &manifests); err != nil {
			return err
		}
		if previous, ok := manifests[manifest.SourceNodeID]; ok {
			if !reflect.DeepEqual(previous, manifest) {
				return continuationError("conflict")
			}
			return nil
		}
		if row.State != "waiting" {
			return continuationError("already_claimed")
		}
		manifests[manifest.SourceNodeID] = manifest
		raw, _ := json.Marshal(manifests)
		return tx.Model(&row).Updates(map[string]any{"manifest_json": string(raw), "revision": row.Revision + 1, "updated_at": s.now()}).Error
	})
}

// Resolve only exact admitted operation IDs. A missing receipt never authorizes a new paid submission.
func (s *Service) continuationResults(tx *gorm.DB, row *model.AssistantContinuation) ([]string, []string, error) {
	var sources []string
	var manifests map[string]ContinuationManifest
	if err := json.Unmarshal([]byte(row.SourceNodeIDs), &sources); err != nil {
		return nil, nil, err
	}
	if err := json.Unmarshal([]byte(row.ManifestJSON), &manifests); err != nil {
		return nil, nil, err
	}
	if len(manifests) != len(sources) {
		return nil, nil, continuationError("waiting")
	}
	raw, err := s.canvas.BoundTo(tx).UserCanvasProject(row.UserID, row.CanvasID)
	if err != nil {
		return nil, nil, err
	}
	var doc struct {
		Nodes []struct {
			ID       string         `json:"id"`
			Metadata map[string]any `json:"metadata"`
		} `json:"nodes"`
	}
	if err = json.Unmarshal(raw, &doc); err != nil {
		return nil, nil, err
	}
	nodes := map[string]map[string]any{}
	for _, n := range doc.Nodes {
		nodes[n.ID] = n.Metadata
	}
	ids, selected := []string{}, []string{}
	waiting := false
	for _, source := range sources {
		manifest, ok := manifests[source]
		if !ok {
			return nil, nil, continuationError("waiting")
		}
		for _, submission := range manifest.Submissions {
			var task model.Task
			err = tx.First(&task, "user_id = ? AND project_id = ? AND client_operation_id = ?", row.UserID, row.CanvasID, submission.OperationID).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				waiting = true
				continue
			}
			if err != nil {
				return nil, nil, err
			}
			if task.Type != "canvas_"+row.Kind {
				return nil, nil, continuationError("task_mismatch")
			}
			var input struct {
				Metadata struct {
					NodeID        string   `json:"nodeId"`
					SourceNodeID  string   `json:"sourceNodeId"`
					OutputNodeIDs []string `json:"outputNodeIds"`
				} `json:"metadata"`
			}
			if err = json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
				return nil, nil, err
			}
			targets := input.Metadata.OutputNodeIDs
			if len(targets) == 0 {
				targets = []string{input.Metadata.NodeID}
			}
			if input.Metadata.SourceNodeID != source || !reflect.DeepEqual(targets, submission.OutputNodeIDs) {
				return nil, nil, continuationError("task_mismatch")
			}
			ids = append(ids, task.ID)
			if task.Status != "succeeded" && task.Status != "failed" && task.Status != "cancelled" {
				waiting = true
				continue
			}
			outputs := map[int]localtask.CanonicalOutput{}
			if task.Status == "succeeded" {
				var results []model.Result
				if err = tx.Where("task_id = ? AND user_id = ? AND kind = ?", task.ID, row.UserID, localtask.ResultKindGenerationOutput).Find(&results).Error; err != nil {
					return nil, nil, err
				}
				decoded, decodeErr := localtask.DecodeOutputResults(results)
				if decodeErr != nil {
					return nil, nil, decodeErr
				}
				for _, output := range decoded {
					if _, duplicate := outputs[output.OutputIndex]; duplicate {
						return ids, nil, continuationError("task_mismatch")
					}
					outputs[output.OutputIndex] = output
				}
				if len(outputs) != len(targets) {
					waiting = true
					continue
				}
			}
			for index, nodeID := range targets {
				meta, exists := nodes[nodeID]
				if !exists || meta["taskId"] != task.ID {
					return ids, nil, continuationError("target_changed")
				}
				if task.Status == "succeeded" {
					key, _ := meta["storageKey"].(string)
					output, present := outputs[index]
					if !present || output.ResourceID == "" || output.MaterializationErrorCode != "" || !strings.HasPrefix(key, "resource:") || meta["status"] != "success" || meta["resourceReloadAvailable"] == true {
						waiting = true
						continue
					}
					// Delivery keeps the task's primary node on every canonical output.
					// Native multi-image destinations are the immutable indexed outputNodeIds
					// checked above, exactly as taskbinding.Bind resolves them.
					if key != "resource:"+output.ResourceID || output.TargetBinding == nil || output.TargetBinding.NodeID != input.Metadata.NodeID || output.MediaType != row.Kind {
						return ids, nil, continuationError("target_changed")
					}
					var resource model.Resource
					if err = tx.First(&resource, "id = ? AND user_id = ? AND status = ?", strings.TrimPrefix(key, "resource:"), row.UserID, "ready").Error; err != nil {
						if errors.Is(err, gorm.ErrRecordNotFound) {
							return ids, nil, continuationError("waiting")
						}
						return nil, nil, err
					}
				}
				selected = append(selected, nodeID)
			}
		}
	}
	if waiting {
		return uniqueSorted(ids), nil, continuationError("waiting")
	}
	var admittedIDs []string
	if row.TaskIDsJSON != "" {
		if err := json.Unmarshal([]byte(row.TaskIDsJSON), &admittedIDs); err != nil {
			return nil, nil, err
		}
	}
	for _, admitted := range admittedIDs {
		found := false
		for _, id := range ids {
			if id == admitted {
				found = true
				break
			}
		}
		if !found {
			return ids, nil, continuationError("task_mismatch")
		}
	}
	return uniqueSorted(ids), uniqueSorted(selected), nil
}

func (s *Service) ListContinuations(userID, canvasID, sessionID string) ([]ContinuationView, error) {
	var rows []model.AssistantContinuation
	err := s.store.DB().Where("user_id = ? AND canvas_id = ? AND session_id = ? AND state IN ?", userID, canvasID, sessionID, []string{"waiting", "claimed", "running"}).Order("created_at ASC").Limit(16).Find(&rows).Error
	if err != nil {
		return nil, err
	}
	views := []ContinuationView{}
	for _, row := range rows {
		if row.State == "waiting" {
			ids, _, readErr := s.continuationResults(s.store.DB(), &row)
			var expected *Error
			if readErr != nil && !errors.As(readErr, &expected) {
				return nil, readErr
			}
			if len(ids) > 0 {
				ids = uniqueSorted(append(ids, continuationView(row).TaskIDs...))
				encoded, _ := json.Marshal(ids)
				if string(encoded) != row.TaskIDsJSON {
					if err := s.store.DB().Model(&model.AssistantContinuation{}).Where("id = ? AND revision = ? AND state = ?", row.ID, row.Revision, "waiting").Updates(map[string]any{"task_ids_json": string(encoded), "revision": row.Revision + 1, "updated_at": s.now()}).Error; err != nil {
						return nil, err
					}
				}
				row.TaskIDsJSON = string(encoded)
			}
		}
		views = append(views, continuationView(row))
	}
	return views, nil
}

// Claim allocates the business turn once, in the same transaction as the receipt.
// Retries forward this exact turn/request pair into the existing Durable owner.
func (s *Service) ClaimContinuation(userID, id string, prepare func(*gorm.DB, *model.AssistantContinuation) (bool, error)) (*ContinuationView, error) {
	var row model.AssistantContinuation
	waiting := false
	var stopped error
	err := s.store.DB().Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, "id = ? AND user_id = ?", id, userID).Error; err != nil {
			return err
		}
		if err := s.continuationScope(tx, &row); err != nil {
			return err
		}
		if row.State == "claimed" || row.State == "running" || row.State == "done" {
			return nil
		}
		if prepare != nil {
			ready, err := prepare(tx, &row)
			if err != nil {
				var changed *Error
				if errors.As(err, &changed) && changed.Reason == "continuation_intent_changed" {
					if err := s.cancelContinuations(tx, row.UserID, row.CanvasID, row.SessionID, row.SourceTurnID, false); err != nil {
						return err
					}
					stopped = changed
					return nil
				}
				return err
			}
			if !ready {
				// Commit newly admitted, already authorized business tasks without
				// allocating a model turn. The same receipt is scanned again.
				waiting = true
				return nil
			}
		}
		ids, selected, err := s.continuationResults(tx, &row)
		if err != nil {
			return err
		}
		raw, err := s.canvas.BoundTo(tx).UserCanvasProject(userID, row.CanvasID)
		if err != nil {
			return err
		}
		var doc map[string]any
		if err = json.Unmarshal(raw, &doc); err != nil {
			return err
		}
		assets, tasks := AssociatedReferences(raw)
		rec := Record{TurnID: row.TurnID, UserID: userID, CanvasID: row.CanvasID, DurableSessionID: row.SessionID, PermissionMode: row.PermissionMode, RevisionBefore: DocumentRevision(doc), CreatedAt: s.now(), State: StateOpen, Document: raw, SelectedNodeIDs: selected, AssociatedAssetIDs: assets, AssociatedTaskIDs: uniqueSorted(append(tasks, ids...))}
		var source model.AssistantTurn
		if err := tx.First(&source, "turn_id = ?", row.SourceTurnID).Error; err != nil {
			return err
		}
		rec.GenerationAuthorizationJSON = source.GenerationAuthorizationJSON
		if _, err = s.store.Insert(tx, recordToModel(rec, s.now())); err != nil {
			return err
		}
		encoded, _ := json.Marshal(ids)
		previous := row.Revision
		row.TaskIDsJSON = string(encoded)
		row.State = "claimed"
		row.Revision++
		row.RevisionBefore = rec.RevisionBefore
		result := tx.Model(&model.AssistantContinuation{}).Where("id = ? AND revision = ? AND state = ?", row.ID, previous, "waiting").Updates(map[string]any{"state": row.State, "revision": row.Revision, "revision_before": row.RevisionBefore, "task_ids_json": row.TaskIDsJSON, "updated_at": s.now()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return continuationError("conflict")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if waiting {
		return nil, continuationError("waiting")
	}
	if stopped != nil {
		return nil, stopped
	}
	view := continuationView(row)
	return &view, nil
}

func (s *Service) VerifyContinuation(userID, id, turnID, sessionID string) error {
	return s.store.DB().Transaction(func(tx *gorm.DB) error {
		var row model.AssistantContinuation
		if err := tx.First(&row, "id = ? AND user_id = ?", id, userID).Error; err != nil {
			return err
		}
		if row.TurnID != turnID || row.SessionID != sessionID || (row.State != "claimed" && row.State != "running") {
			return continuationError("cancelled")
		}
		if err := s.continuationScope(tx, &row); err != nil {
			return err
		}
		if _, _, err := s.continuationResults(tx, &row); err != nil {
			return err
		}
		return tx.Model(&row).Update("state", "running").Error
	})
}

// pendingOnly preserves an already running turn so explicit user input can steer it.
func (s *Service) CancelContinuations(userID, canvasID, sessionID string, pendingOnly bool) error {
	return s.store.DB().Transaction(func(tx *gorm.DB) error {
		return s.cancelContinuations(tx, userID, canvasID, sessionID, "", pendingOnly)
	})
}

func (s *Service) cancelContinuations(tx *gorm.DB, userID, canvasID, sessionID, sourceTurnID string, pendingOnly bool, exceptSource ...string) error {
	// The source turn is the durable intent token. Mark it even when confirmation
	// preparation has not created a continuation yet; cancelling existing rows
	// alone lets a delayed arm resurrect the old plan after new user intent.
	sources := tx.Model(&model.AssistantTurn{}).Where("user_id = ? AND canvas_id = ?", userID, canvasID)
	if sessionID != "" {
		sources = sources.Where("durable_session_id = ?", sessionID)
	}
	if sourceTurnID != "" {
		sources = sources.Where("turn_id = ?", sourceTurnID)
	}
	if len(exceptSource) > 0 && exceptSource[0] != "" {
		sources = sources.Where("turn_id <> ?", exceptSource[0])
	}
	if err := sources.Update("continuation_invalidated", true).Error; err != nil {
		return err
	}
	states := []string{"waiting", "claimed"}
	if !pendingOnly {
		states = append(states, "running")
	}
	query := tx.Where("user_id = ? AND canvas_id = ? AND state IN ?", userID, canvasID, states)
	if sessionID != "" {
		query = query.Where("session_id = ?", sessionID)
	}
	if sourceTurnID != "" {
		query = query.Where("source_turn_id = ?", sourceTurnID)
	}
	var rows []model.AssistantContinuation
	if err := query.Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		if err := tx.Model(&model.AssistantContinuation{}).Where("id = ? AND state IN ?", row.ID, states).Updates(map[string]any{"state": "cancelled", "revision": gorm.Expr("revision + 1")}).Error; err != nil {
			return err
		}
		if row.State != "waiting" {
			if err := tx.Model(&model.AssistantTurn{}).Where("turn_id = ?", row.TurnID).Update("state", StateSettled).Error; err != nil {
				return err
			}
		}
	}
	return nil
}

// Used by every operation authorization and recovery, not merely by the UI.
func (s *Service) continuationTurnAllowed(tx *gorm.DB, turnID string) error {
	var row model.AssistantContinuation
	err := tx.First(&row, "turn_id = ?", turnID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.continuationScope(tx, &row)
}
