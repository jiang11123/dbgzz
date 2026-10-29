package app

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	localtask "infinite-canvas/backend/internal/task"
)

type AssistantProductionConfirmation struct {
	CanvasID   string                        `json:"canvasId"`
	ProposalID string                        `json:"proposalId"`
	Kind       string                        `json:"kind"`
	NodeIDs    []string                      `json:"nodeIds"`
	Targets    []operations.GenerationTarget `json:"targets"`
}

// Confirmation authorizes a finite set of exact paid inputs. Model calls
// cannot add targets, change the selected model or enlarge an image batch.
// The existing business round owns this authorization, not a second workflow.
func (s *Service) ConfirmAssistantProduction(userID, turnID string, input AssistantProductionConfirmation) (any, error) {
	if err := s.CheckAssistantProposalRunnable(userID, input.CanvasID, turnID); err != nil {
		return nil, err
	}
	var result any
	err := s.repo.DB().Transaction(func(tx *gorm.DB) error {
		domain := s.BindDomain(tx).(*operationSession)
		raw, err := domain.UserCanvasProject(userID, input.CanvasID)
		if err != nil {
			return err
		}
		var doc map[string]any
		if err = json.Unmarshal(raw, &doc); err != nil {
			return err
		}
		ids := []string{}
		for _, target := range input.Targets {
			ids = append(ids, target.NodeID)
		}
		current, err := operations.GenerationTargets(domain, doc, ids)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(current, input.Targets) {
			return operations.Conflict("production_changed", "制作方案已变化，请重新确认", nil)
		}
		var source model.AssistantTurn
		if err = tx.First(&source, "turn_id = ? AND user_id = ? AND canvas_id = ?", turnID, userID, input.CanvasID).Error; err != nil {
			return err
		}
		if source.Undone || source.ContinuationInvalidated || source.DurableSessionID == "" {
			return operations.PreconditionFailed("production_revoked", "这次制作授权已停止，请重新确认", nil)
		}
		plan := operations.GenerationAuthorization{SourceTurnID: turnID, ProposalID: input.ProposalID, Targets: current}
		encoded, _ := json.Marshal(plan)
		if source.GenerationAuthorizationJSON != "" && source.GenerationAuthorizationJSON != string(encoded) {
			return operations.Conflict("production_changed", "这一轮已确认了不同的制作方案", nil)
		}
		if err = tx.Model(&source).Update("generation_authorization_json", string(encoded)).Error; err != nil {
			return err
		}
		batch := []operations.GenerationTarget{}
		wanted := map[string]bool{}
		for _, id := range input.NodeIDs {
			wanted[id] = true
		}
		for _, target := range current {
			if wanted[target.NodeID] {
				if target.Kind != input.Kind {
					return operations.InvalidArg("invalid_kind", "首批素材类型不一致")
				}
				batch = append(batch, target)
			}
		}
		if len(batch) == 0 || len(batch) != len(wanted) {
			return operations.InvalidArg("invalid_batch", "首批素材不在制作计划内")
		}
		result, err = domain.admitProductionTargets(userID, input.CanvasID, plan, batch)
		if err != nil {
			return err
		}
		turns := assistantturns.New(assistantturns.NewStore(domain.repo), assistantCanvasFactory{s}, s.assistantTurnDir())
		continuation, err := turns.ArmContinuation(userID, assistantturns.ContinuationInput{CanvasID: input.CanvasID, SessionID: source.DurableSessionID, SourceTurnID: turnID, ProposalID: input.ProposalID, Kind: input.Kind, NodeIDs: input.NodeIDs})
		if err != nil {
			return err
		}
		for _, target := range batch {
			if err = turns.RegisterContinuationManifest(userID, continuation.ID, assistantturns.ContinuationManifest{SourceNodeID: target.NodeID, Submissions: []assistantturns.ContinuationSubmission{{OperationID: productionTaskKey(plan, target.NodeID), OutputNodeIDs: []string{target.NodeID}}}}); err != nil {
				return err
			}
		}
		result.(map[string]any)["continuationId"] = continuation.ID
		return nil
	})
	return result, err
}

func productionTaskKey(plan operations.GenerationAuthorization, nodeID string) string {
	return "proposal:" + plan.ProposalID + ":" + nodeID
}

func (s *operationSession) SubmitAuthorizedGeneration(userID, turnID, canvasID string, targets []operations.GenerationTarget) (any, error) {
	var source model.AssistantTurn
	if err := s.tx.First(&source, "turn_id = ? AND user_id = ? AND canvas_id = ?", turnID, userID, canvasID).Error; err != nil {
		return nil, err
	}
	var plan operations.GenerationAuthorization
	if json.Unmarshal([]byte(source.GenerationAuthorizationJSON), &plan) != nil || plan.SourceTurnID == "" {
		return nil, operations.PreconditionFailed("production_authorization_required", "请先确认本次整片制作方案", nil)
	}
	var owner model.AssistantTurn
	if err := s.tx.First(&owner, "turn_id = ? AND user_id = ? AND canvas_id = ?", plan.SourceTurnID, userID, canvasID).Error; err != nil {
		return nil, err
	}
	if owner.Undone || owner.ContinuationInvalidated || owner.DurableSessionID != source.DurableSessionID || owner.GenerationAuthorizationJSON != source.GenerationAuthorizationJSON {
		return nil, operations.PreconditionFailed("production_revoked", "本次制作授权已停止", nil)
	}
	approved := map[string]operations.GenerationTarget{}
	for _, target := range plan.Targets {
		approved[target.NodeID] = target
	}
	for _, target := range targets {
		if !reflect.DeepEqual(approved[target.NodeID], target) {
			return nil, operations.PreconditionFailed("production_changed", "素材或参数超出已确认的制作方案，请重新确认", nil)
		}
	}
	return s.admitProductionTargets(userID, canvasID, plan, targets)
}

func (s *operationSession) admitProductionTargets(userID, canvasID string, plan operations.GenerationAuthorization, targets []operations.GenerationTarget) (any, error) {
	raw, err := s.canvas.UserCanvasProject(userID, canvasID)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	nodes := map[string]map[string]any{}
	for _, v := range doc["nodes"].([]any) {
		n, _ := v.(map[string]any)
		nodes[fmt.Sprint(n["id"])] = n
	}
	policy, err := s.service.runtimePolicyWithRepo(s.repo)
	if err != nil {
		return nil, err
	}
	adapter := operationRenderDependencies{s: s, policy: policy}
	deps := s.service.taskDependencies()
	deps.Projects = adapter
	deps.Policy = adapter
	deps.Persist = adapter
	deps.Present = operationRenderPresenter{}
	deps.Logs = nil
	deps.Activity = nil
	domain := localtask.NewService(localtask.NewStore(s.repo), deps)
	taskIDs := []string{}
	nodeIDs := []string{}
	changed := false
	for _, target := range targets {
		key := productionTaskKey(plan, target.NodeID)
		existing, err := s.repo.TaskByClientOperation(userID, key)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			// Validate the original admitted request against its hash before
			// repairing a missing node receipt. Never re-resolve credentials or
			// references merely to recover an already accepted task.
			if err := validateProductionTask(existing, canvasID, target); err != nil {
				return nil, err
			}
			meta, _ := nodes[target.NodeID]["metadata"].(map[string]any)
			if meta == nil {
				meta = map[string]any{}
				nodes[target.NodeID]["metadata"] = meta
			}
			// Preserve successful material bindings. Missing receipts use the
			// normal delivery recovery path with the same task identity.
			if id, _ := meta["taskId"].(string); id != "" && id != existing.ID {
				return nil, operations.Conflict("production_node_changed", "素材节点已使用其他任务，请先检查当前结果", nil)
			}
			for field, value := range map[string]any{"taskId": existing.ID, "taskStatus": string(existing.Status), "taskClientOperationId": key, "generationSubmissionState": "accepted"} {
				if meta[field] != value {
					meta[field] = value
					changed = true
				}
			}
			if existing.Status == model.TaskStatusFailed || existing.Status == model.TaskStatusCancelled {
				if meta["status"] != "error" {
					meta["status"] = "error"
					changed = true
				}
				if meta["error"] != existing.Error {
					meta["error"] = existing.Error
					changed = true
				}
			} else if storage, _ := meta["storageKey"].(string); storage == "" && meta["status"] != "loading" {
				meta["status"] = "loading"
				changed = true
			}
			taskIDs = append(taskIDs, existing.ID)
			nodeIDs = append(nodeIDs, target.NodeID)
			continue
		}
		input, err := s.productionTaskInput(userID, target, nodes)
		if err != nil {
			return nil, err
		}
		input["metadata"].(map[string]any)["clientOperationId"] = key
		input["metadata"].(map[string]any)["assistantProductionTargetHash"] = productionTargetHash(target)
		task, err := domain.CreateTask(userID, localtask.CreateRequest{ProjectID: canvasID, Type: "canvas_" + target.Kind, Prompt: target.Prompt, Input: input})
		if err != nil {
			return nil, err
		}
		meta, _ := nodes[target.NodeID]["metadata"].(map[string]any)
		if meta == nil {
			meta = map[string]any{}
			nodes[target.NodeID]["metadata"] = meta
		}
		meta["taskId"], meta["taskStatus"], meta["status"] = task.ID, string(task.Status), "loading"
		meta["taskClientOperationId"], meta["generationSubmissionState"] = key, "accepted"
		changed = true
		taskIDs = append(taskIDs, task.ID)
		nodeIDs = append(nodeIDs, target.NodeID)
	}
	revision := assistantDocRevision(doc)
	if changed {
		encoded, _ := json.Marshal(doc)
		summary, _, err := s.canvas.CommitUserCanvasDocument(userID, canvasID, revision, encoded)
		if err != nil {
			return nil, err
		}
		revision = summary.Revision
	}
	return map[string]any{"canvasId": canvasID, "taskIds": taskIDs, "nodeIds": nodeIDs, "status": "submitted", "revision": revision, "authorized": true}, nil
}

func productionTargetHash(target operations.GenerationTarget) string {
	encoded, _ := json.Marshal(target)
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

func validateProductionTask(task *model.Task, canvasID string, target operations.GenerationTarget) error {
	var original struct {
		Metadata map[string]any `json:"metadata"`
	}
	if err := json.Unmarshal([]byte(task.InputJSON), &original); err != nil {
		return err
	}
	if task.ProjectID != canvasID || task.Type != "canvas_"+target.Kind || task.Prompt != target.Prompt || original.Metadata["assistantProductionTargetHash"] != productionTargetHash(target) {
		return operations.Conflict("production_task_changed", "原制作任务与确认记录不一致，请先检查原任务", nil)
	}
	return nil
}

func (s *operationSession) productionTaskInput(userID string, target operations.GenerationTarget, nodes map[string]map[string]any) (map[string]any, error) {
	config, err := s.service.assistantGenerationConfig(target)
	if err != nil {
		return nil, err
	}
	input := map[string]any{"mode": target.Kind, "prompt": target.Prompt, "config": config, "metadata": map[string]any{"nodeId": target.NodeID, "sourceNodeId": target.NodeID, "outputNodeIds": []string{target.NodeID}, "source": "assistant-production"}}
	for key, value := range target.Metadata {
		input["metadata"].(map[string]any)[key] = value
	}
	for _, key := range []string{"videoStartFrameNodeId", "videoEndFrameNodeId", "videoMiddleFrameNodeId"} {
		if value := target.Parameters[key]; value != "" {
			input["metadata"].(map[string]any)[key] = value
		}
	}
	for _, id := range target.ReferenceNodeIDs {
		node := nodes[id]
		meta, _ := node["metadata"].(map[string]any)
		if meta["status"] == "loading" || meta["taskStatus"] == "queued" || meta["taskStatus"] == "running" || meta["generationSubmissionState"] == "submitting" {
			return nil, operations.PreconditionFailed("generation_dependencies_not_ready", "参考素材仍在生成，请等待原任务保存", nil)
		}
		key, _ := meta["storageKey"].(string)
		if !strings.HasPrefix(key, "resource:") {
			return nil, operations.PreconditionFailed("generation_dependencies_not_ready", "参考素材尚未保存", nil)
		}
		resource, err := s.repo.Resource(strings.TrimPrefix(key, "resource:"))
		if err != nil {
			return nil, err
		}
		if resource.UserID != userID || resource.Status != "ready" {
			return nil, operations.PreconditionFailed("generation_dependencies_not_ready", "参考素材尚未就绪或不属于当前工作区", nil)
		}
		kind := fmt.Sprint(node["type"])
		field := map[string]string{"image": "referenceImages", "video": "referenceVideos", "audio": "referenceAudios"}[kind]
		if field == "" {
			return nil, operations.InvalidArg("unsupported_reference", "本次制作只支持已保存的图片、视频和声音参考")
		}
		list, _ := input[field].([]any)
		input[field] = append(list, map[string]any{"id": id, "storageKey": key, "mimeType": resource.MimeType, "width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs})
	}
	return input, nil
}
