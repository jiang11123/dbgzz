package creation

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/canvas/capability"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func (s *Service) CanvasSnapshot(userID, id string) (map[string]any, error) {
	run, err := s.repo.CreationRun(userID, id)
	if err != nil {
		return nil, MapError(err)
	}
	project, err := s.repo.CanvasProjectForUser(userID, run.CanvasID)
	if err != nil {
		return nil, MapError(err)
	}
	doc, err := parseDocument(project.PayloadJSON)
	return map[string]any{"document": doc, "snapshotHash": Hash(doc)}, err
}

func (s *Service) CreateCanvas(userID, id string, cmd Command) (map[string]any, error) {
	var out map[string]any
	err := s.repo.MutateCreationRun(userID, id, func(run *model.CreationRun, repo *repository.Repository) error {
		if err := validateGuard(run, cmd.Guard, s.deps.now()); err != nil {
			return err
		}
		if run.Status == "paused" || run.Status == "cancelled" {
			return Conflict("请先恢复创作任务")
		}
		if run.ApprovedAt == nil {
			return Conflict("请先确认方案")
		}
		if run.CanvasID != "" {
			if _, err := repo.CanvasProjectForUser(userID, run.CanvasID); err != nil {
				return Conflict("已关联画布失效，请核对后继续")
			}
			out = map[string]any{"run": RunView(*run), "canvasId": run.CanvasID}
			return nil
		}
		now := s.deps.now()
		cid := s.deps.newID()
		doc := map[string]any{
			"id": cid, "title": "智能创作",
			"createdAt": now.Format(time.RFC3339Nano), "updatedAt": now.Format(time.RFC3339Nano),
			"nodes": []any{}, "connections": []any{}, "chatSessions": []any{}, "activeChatId": nil,
			"backgroundMode": "dots", "showImageInfo": true,
			"viewport": map[string]any{"x": 0, "y": 0, "k": 1}, "directorScenes": []any{},
		}
		raw, _ := json.Marshal(doc)
		project := model.CanvasProject{ID: cid, UserID: userID, Title: "智能创作", PayloadJSON: string(raw), CreatedAt: now, UpdatedAt: now}
		if err := s.validateCanvasQuota(userID, repo, true, int64(len(raw))); err != nil {
			return err
		}
		if err := repo.CreateCreationCanvas(&project); err != nil {
			return err
		}
		run.CanvasID = cid
		run.Revision++
		run.Status = "waiting_canvas"
		out = map[string]any{"run": RunView(*run), "canvasId": cid}
		return nil
	})
	return out, MapError(err)
}

func (s *Service) CommitCanvas(userID, id string, cmd Command) (map[string]any, error) {
	if err := canvas.ValidateSyncedPayload(cmd.Document, "画布"); err != nil {
		return nil, err
	}
	if err := ValidateJSON(cmd.Document); err != nil {
		return nil, err
	}
	if s.deps.Media == nil {
		return nil, kernel.NewAppError(kernel.CodeInternal, "画布媒体校验不可用")
	}
	doc, err := parseDocument(string(cmd.Document))
	if err != nil {
		return nil, err
	}
	var out map[string]any
	err = s.repo.MutateCreationRun(userID, id, func(run *model.CreationRun, repo *repository.Repository) error {
		if err := s.deps.Media.ValidateDocument(userID, repo, cmd.Document); err != nil {
			return err
		}
		if err := validateGuard(run, cmd.Guard, s.deps.now()); err != nil {
			return err
		}
		if run.Status == "paused" || run.Status == "cancelled" {
			return Conflict("请先恢复创作任务")
		}
		if run.ApprovedAt == nil {
			return Conflict("当前方案尚未批准")
		}
		project, err := repo.CanvasProjectForUser(userID, run.CanvasID)
		if err != nil {
			return err
		}
		before, err := parseDocument(project.PayloadJSON)
		if err != nil {
			return err
		}
		if Hash(before) != cmd.ExpectedSnapshotHash {
			return Conflict("画布已变化，请重新读取后核对")
		}
		var ops []CanvasOp
		if err = json.Unmarshal([]byte(run.ApprovedOperationsJSON), &ops); err != nil {
			return err
		}
		if err = ValidateCanvasDiff(repo, userID, run, before, doc, ops); err != nil {
			return err
		}
		previous := project.PayloadJSON
		project.PayloadJSON = string(cmd.Document)
		if err = s.validateCanvasQuota(userID, repo, false, int64(len(cmd.Document)-len(previous))); err != nil {
			return err
		}
		if err = saveCanvasWithHistory(repo, project, previous); err != nil {
			return err
		}
		out = map[string]any{"snapshotHash": Hash(doc)}
		return nil
	})
	return out, MapError(err)
}

func (s *Service) validateCanvasQuota(userID string, repo *repository.Repository, creating bool, delta int64) error {
	if s.deps.Quota == nil {
		return kernel.NewAppError(kernel.CodeInternal, "创作配额服务不可用")
	}
	return s.deps.Quota.ValidateCanvas(userID, repo, creating, delta)
}

func saveCanvasWithHistory(repo *repository.Repository, project *model.CanvasProject, previous string) error {
	before, err := repo.CanvasProjectForUser(project.UserID, project.ID)
	if err != nil {
		return err
	}
	if before.PayloadJSON != previous || before.Revision != project.Revision {
		return repository.ErrCreationConflict
	}
	project.UpdatedAt = time.Now().UTC()
	err = canvas.SaveDocumentWithHistory(repo, before, project, "automatic")
	if errors.Is(err, repository.ErrCanvasRevisionConflict) {
		return repository.ErrCreationConflict
	}
	return err
}

func AddedNode(op CanvasOp) map[string]any {
	desc, known := capability.BuiltinRegistry().Resolve(op.NodeType)
	width, height, title := 340.0, 240.0, "Note"
	if known {
		width, height, title = desc.DefaultWidth, desc.DefaultHeight, desc.Label
	}
	metadata := map[string]any{"content": "", "status": "idle"}
	if known && op.Metadata == nil {
		metadata = desc.Metadata("")
	}
	if op.Width != nil {
		width = *op.Width
	}
	if op.Height != nil {
		height = *op.Height
	}
	if op.Title != "" {
		title = op.Title
	}
	position := op.Position
	if position == nil {
		position = map[string]any{"x": float64(0), "y": float64(0)}
		if op.X != nil {
			position["x"] = *op.X
		}
		if op.Y != nil {
			position["y"] = *op.Y
		}
	}
	return map[string]any{"id": op.ID, "type": op.NodeType, "title": title, "position": position, "width": width, "height": height, "metadata": MergeMaps(metadata, op.Metadata)}
}

func ValidateCanvasDiff(repo *repository.Repository, userID string, run *model.CreationRun, before, after map[string]any, ops []CanvasOp) error {
	baselineNodes := map[string]map[string]any{}
	if run.ApprovedCanvasJSON != "" {
		baseline, err := parseDocument(run.ApprovedCanvasJSON)
		if err != nil {
			return err
		}
		baselineNodes, err = documentObjects(baseline["nodes"])
		if err != nil {
			return err
		}
	}
	for key, value := range before {
		if key == "nodes" || key == "connections" || key == "updatedAt" {
			continue
		}
		if !reflect.DeepEqual(value, after[key]) {
			return Conflict("画布提交修改了方案外内容")
		}
	}
	for key := range after {
		if _, ok := before[key]; !ok && key != "updatedAt" {
			return Conflict("画布提交包含方案外字段")
		}
	}
	oldNodes, err := documentObjects(before["nodes"])
	if err != nil {
		return err
	}
	newNodes, err := documentObjects(after["nodes"])
	if err != nil {
		return err
	}
	oldEdges, err := documentObjects(before["connections"])
	if err != nil {
		return err
	}
	newEdges, err := documentObjects(after["connections"])
	if err != nil {
		return err
	}
	add := map[string]CanvasOp{}
	updates := map[string][]CanvasOp{}
	edges := map[string]CanvasOp{}
	approved := map[string]bool{}
	for _, op := range ops {
		switch op.Type {
		case "add_node":
			add[op.ID] = op
			approved[op.ID] = true
		case "update_node":
			updates[op.ID] = append(updates[op.ID], op)
			approved[op.ID] = true
		case "connect_nodes":
			edges[op.ID] = op
		}
	}
	for id, old := range oldNodes {
		next := newNodes[id]
		if next == nil {
			return Conflict("不允许删除已有节点")
		}
		if reflect.DeepEqual(old, next) {
			continue
		}
		expected := MergeMaps(old, nil)
		metadata, _ := old["metadata"].(map[string]any)
		metadata = MergeMaps(metadata, nil)
		for _, op := range updates[id] {
			if baseline := baselineNodes[id]; baseline != nil {
				for key, want := range op.Patch {
					if key == "metadata" {
						continue
					}
					if !reflect.DeepEqual(old[key], baseline[key]) && !reflect.DeepEqual(old[key], want) {
						return Conflict("节点已被手工编辑，请重新确认修改范围")
					}
				}
				baselineMeta, _ := baseline["metadata"].(map[string]any)
				patchMeta, _ := op.Patch["metadata"].(map[string]any)
				for key, want := range MergeMaps(patchMeta, op.Metadata) {
					if !reflect.DeepEqual(metadata[key], baselineMeta[key]) && !reflect.DeepEqual(metadata[key], want) {
						return Conflict("节点内容已被手工编辑，请重新确认")
					}
				}
			}
			for key, value := range op.Patch {
				if key == "metadata" {
					m, _ := value.(map[string]any)
					metadata = MergeMaps(metadata, m)
				} else {
					expected[key] = value
				}
			}
			metadata = MergeMaps(metadata, op.Metadata)
		}
		expected["metadata"] = metadata
		if reflect.DeepEqual(expected, next) {
			continue
		}
		if !approved[id] {
			return Conflict("不能修改方案外节点")
		}
		actualMeta, _ := next["metadata"].(map[string]any)
		withoutMeta := MergeMaps(next, nil)
		withoutMeta["metadata"] = metadata
		if !reflect.DeepEqual(expected, withoutMeta) {
			return Conflict("节点字段超出批准范围")
		}
		if err := ValidateResultMetadata(repo, userID, run.ID, id, metadata, actualMeta); err != nil {
			return err
		}
	}
	for id, node := range newNodes {
		if oldNodes[id] != nil {
			continue
		}
		op, ok := add[id]
		if !ok {
			return Conflict("节点未获方案批准")
		}
		expected := AddedNode(op)
		if !reflect.DeepEqual(expected, node) {
			return Conflict("新增节点参数与批准方案不同")
		}
	}
	for id, edge := range oldEdges {
		if !reflect.DeepEqual(edge, newEdges[id]) {
			return Conflict("不允许修改或删除已有连线")
		}
	}
	for id, edge := range newEdges {
		if oldEdges[id] != nil {
			continue
		}
		op, ok := edges[id]
		if !ok {
			return Conflict("连线未获批准")
		}
		expected := map[string]any{"id": id, "fromNodeId": op.FromNodeID, "toNodeId": op.ToNodeID}
		if op.FromHandleID != "" {
			expected["fromHandleId"] = op.FromHandleID
		}
		if op.ToHandleID != "" {
			expected["toHandleId"] = op.ToHandleID
		}
		if !reflect.DeepEqual(expected, edge) || newNodes[op.FromNodeID] == nil || newNodes[op.ToNodeID] == nil {
			return Conflict("连线参数与批准范围不同")
		}
	}
	return nil
}

func ValidateResultMetadata(repo *repository.Repository, userID, runID, nodeID string, before, after map[string]any) error {
	taskID := stringValue(after["taskId"])
	if taskID == "" {
		taskID = stringValue(after["generationTaskId"])
	}
	if taskID == "" {
		return Conflict("结果回写缺少真实任务")
	}
	items, err := repo.CreationSubmissions(userID, runID)
	if err != nil {
		return err
	}
	found := false
	for _, item := range items {
		if item.TaskID == nil || *item.TaskID != taskID {
			continue
		}
		var request TaskRequest
		_ = json.Unmarshal([]byte(item.RequestJSON), &request)
		if stringValue(request.Input["nodeId"]) == nodeID {
			found = true
			break
		}
	}
	if !found {
		return Conflict("任务不属于当前创作节点")
	}
	task, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return err
	}
	if task.Status != model.TaskStatusSucceeded {
		return Conflict("生成任务尚未成功")
	}
	var result any
	if err = json.Unmarshal([]byte(task.ResultJSON), &result); err != nil {
		return err
	}
	storageKey := stringValue(after["storageKey"])
	if !strings.HasPrefix(storageKey, "resource:") || !resultContains(result, []string{"storageKey"}, storageKey) {
		return Conflict("回写素材不是任务生成资源")
	}
	resource, err := repo.ResourceForUser(userID, strings.TrimPrefix(storageKey, "resource:"))
	if err != nil {
		return err
	}
	if resource.Status != model.ResourceStatusReady {
		return Conflict("任务资源尚未就绪")
	}
	for key := range before {
		if _, ok := after[key]; !ok {
			return Conflict("结果回写不能移除已有字段")
		}
	}
	for key, value := range after {
		if reflect.DeepEqual(value, before[key]) {
			continue
		}
		switch key {
		case "taskId", "generationTaskId":
			if value != taskID {
				return Conflict("任务引用不匹配")
			}
		case "status":
			if value != "success" {
				return Conflict("结果状态不匹配")
			}
		case "assetId":
			owned, e := repo.AssetsForUserIDs(userID, []string{stringValue(value)})
			if e != nil {
				return e
			}
			if len(owned) != 1 || !assets.DocumentReferences(owned[0].PayloadJSON, map[string]struct{}{resource.ID: {}}) {
				return Conflict("素材记录不属于任务结果资源")
			}
		case "content", "storageKey", "naturalWidth", "naturalHeight", "durationMs", "bytes", "mimeType":
			resourceValue := map[string]any{
				"content": "/api/resources/" + resource.ID + "/file", "storageKey": storageKey,
				"naturalWidth": float64(resource.Width), "naturalHeight": float64(resource.Height),
				"durationMs": float64(resource.DurationMs), "bytes": float64(resource.Size), "mimeType": resource.MimeType,
			}
			if reflect.DeepEqual(value, resourceValue[key]) {
				continue
			}
			keys := map[string][]string{
				"content": {"url", "imageUrl", "videoUrl", "content"}, "storageKey": {"storageKey"},
				"naturalWidth": {"width", "naturalWidth"}, "naturalHeight": {"height", "naturalHeight"},
				"durationMs": {"durationMs"}, "bytes": {"bytes", "size"}, "mimeType": {"mimeType"},
			}
			if !resultContains(result, keys[key], value) {
				return Conflict("回写资源字段不属于真实任务结果")
			}
		default:
			return Conflict("结果回写试图修改手工字段")
		}
	}
	return nil
}

func resultContains(value any, keys []string, want any) bool {
	switch v := value.(type) {
	case map[string]any:
		for key, child := range v {
			for _, allowed := range keys {
				if key == allowed && reflect.DeepEqual(child, want) {
					return true
				}
			}
			if resultContains(child, keys, want) {
				return true
			}
		}
	case []any:
		for _, child := range v {
			if resultContains(child, keys, want) {
				return true
			}
		}
	}
	return false
}
