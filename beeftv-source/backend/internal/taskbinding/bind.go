package taskbinding

import (
	"encoding/json"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

const maxBindRevisionAttempts = 4

// Bind attaches a durable backend task output to the original canvas node in
// one domain step. Canvas CAS retries stay inside this call so the operation
// identity (task/output/node effect key) does not change.
func Bind(ports Ports, userID string, req Request) (Receipt, error) {
	if ports == nil {
		return Receipt{}, invalid("bind_ports_unavailable", "绑定端口不可用")
	}
	userID = strings.TrimSpace(userID)
	req.CanvasID = strings.TrimSpace(req.CanvasID)
	req.TaskID = strings.TrimSpace(req.TaskID)
	req.NodeID = strings.TrimSpace(req.NodeID)
	req.EffectKey = strings.TrimSpace(req.EffectKey)
	if userID == "" {
		return Receipt{}, invalid("missing_scope", "缺少用户/工作区作用域")
	}
	if req.CanvasID == "" || req.TaskID == "" || req.NodeID == "" {
		return Receipt{}, invalid("invalid_params", "canvasId、taskId、nodeId 必填")
	}
	if req.OutputIndex < 0 {
		return Receipt{}, invalid("invalid_params", "outputIndex 无效")
	}
	task, err := ports.Task(userID, req.TaskID)
	if err != nil {
		return Receipt{}, mapPortError(err)
	}
	if task == nil || strings.TrimSpace(task.ID) == "" {
		return Receipt{}, notFound("task_not_found", "任务不存在")
	}
	if strings.TrimSpace(task.UserID) != userID {
		return Receipt{}, forbidden("task_foreign", "任务不属于当前用户")
	}
	if task.Status != model.TaskStatusSucceeded {
		return Receipt{}, precondition("task_not_succeeded", "只有成功的任务才能绑定到画布")
	}
	if projectID := strings.TrimSpace(task.ProjectID); projectID != "" && projectID != req.CanvasID {
		return Receipt{}, conflict("canvas_mismatch", "任务不属于这块画布")
	}
	target := localtask.OutputBinding(*task, req.OutputIndex)
	nodeID := strings.TrimSpace(target.NodeID)
	if localtask.SeedreamOutputRoot(*task) != "" && nodeID == "" {
		return Receipt{}, invalid("invalid_params", "outputIndex 无效")
	}
	// Multi-output image tasks freeze the destination for every output before
	// submission. Never accept a new destination supplied by the bind request.
	if task.Type == "canvas_image" && localtask.SeedreamOutputRoot(*task) == "" {
		var input struct {
			Metadata struct {
				OutputNodeIDs []string `json:"outputNodeIds"`
			} `json:"metadata"`
		}
		if json.Unmarshal([]byte(task.InputJSON), &input) == nil && len(input.Metadata.OutputNodeIDs) > 0 {
			if req.OutputIndex >= len(input.Metadata.OutputNodeIDs) {
				return Receipt{}, conflict("node_mismatch", "产物未指定画布节点")
			}
			nodeID = strings.TrimSpace(input.Metadata.OutputNodeIDs[req.OutputIndex])
			if nodeID == "" {
				return Receipt{}, conflict("node_mismatch", "产物未指定画布节点")
			}
		}
	}
	if nodeID != "" && nodeID != req.NodeID {
		return Receipt{}, conflict("node_mismatch", "只能绑定到任务原先指定的节点")
	}
	wantKey := localtask.AttachNodeEffectKey(req.TaskID, req.NodeID, req.OutputIndex)
	if req.EffectKey == "" {
		req.EffectKey = wantKey
	}
	if req.EffectKey != wantKey {
		return Receipt{}, invalid("effect_identity_mismatch", "操作身份必须是 attach-node:任务:节点:输出序号")
	}

	patch, err := durablePatch(ports, userID, *task, req)
	if err != nil {
		return Receipt{}, err
	}
	var result NodeBindResult
	for attempt := 0; attempt < maxBindRevisionAttempts; attempt++ {
		result, err = ports.BindExistingNode(userID, patch)
		if err == nil {
			return receiptFor(req, patch, result), nil
		}
		if !isRevisionConflict(err) {
			return Receipt{}, mapPortError(err)
		}
	}
	return Receipt{}, mapPortError(err)
}

func durablePatch(ports Ports, userID string, task model.Task, req Request) (NodePatch, error) {
	if isTextTask(task) {
		return textPatch(task, req)
	}
	outputs, err := ports.GenerationOutputs(task.ID)
	if err != nil {
		return NodePatch{}, mapPortError(err)
	}
	var output localtask.CanonicalOutput
	found := false
	for _, item := range outputs {
		if item.OutputIndex == req.OutputIndex {
			output = item
			found = true
			break
		}
	}
	if !found {
		return NodePatch{}, precondition("output_not_ready", "任务产物尚未交付，不能绑定到画布")
	}
	if strings.TrimSpace(output.MaterializationErrorCode) != "" && strings.TrimSpace(output.MaterializedAssetID) == "" {
		return NodePatch{}, precondition(output.MaterializationErrorCode, "任务产物不可用，不能绑定到画布")
	}
	if strings.TrimSpace(output.MaterializedAssetID) == "" || strings.TrimSpace(output.ResourceID) == "" {
		return NodePatch{}, precondition("output_not_ready", "任务产物尚未就绪，不能绑定到画布")
	}
	resource, err := ports.OwnedReadyResource(userID, output.ResourceID)
	if err != nil {
		return NodePatch{}, mapPortError(err)
	}
	if resource == nil || strings.TrimSpace(resource.ID) == "" || resource.Status != model.ResourceStatusReady {
		return NodePatch{}, precondition("resource_not_ready", "任务资源未就绪，不能绑定到画布")
	}
	if strings.TrimSpace(resource.UserID) != userID {
		return NodePatch{}, forbidden("resource_foreign", "任务资源不属于当前用户")
	}
	if strings.TrimSpace(resource.ID) != strings.TrimSpace(output.ResourceID) {
		return NodePatch{}, precondition("resource_mismatch", "任务资源与产物记录不一致，不能绑定到画布")
	}
	asset, err := ports.OwnedAsset(userID, output.MaterializedAssetID)
	if err != nil {
		return NodePatch{}, mapPortError(err)
	}
	if asset == nil || strings.TrimSpace(asset.ID) == "" {
		return NodePatch{}, precondition("output_not_ready", "任务素材尚未就绪，不能绑定到画布")
	}
	if strings.TrimSpace(asset.UserID) != userID {
		return NodePatch{}, forbidden("asset_foreign", "任务素材不属于当前用户")
	}
	if assetResourceID(asset) != strings.TrimSpace(output.ResourceID) {
		return NodePatch{}, precondition("resource_mismatch", "任务素材未指向本次产物资源，不能绑定到画布")
	}
	mediaType := strings.TrimSpace(output.MediaType)
	if mediaType == "" {
		mediaType = strings.TrimSpace(resource.Kind)
	}
	return NodePatch{
		CanvasID:    req.CanvasID,
		NodeID:      req.NodeID,
		TaskID:      req.TaskID,
		OutputIndex: req.OutputIndex,
		EffectKey:   req.EffectKey,
		MediaType:   mediaType,
		AssetID:     output.MaterializedAssetID,
		ResourceID:  resource.ID,
		StorageKey:  "resource:" + resource.ID,
		Content:     assets.FileURL(resource.ID),
		MimeType:    resource.MimeType,
		Bytes:       resource.Size,
		Width:       resource.Width,
		Height:      resource.Height,
		DurationMs:  resource.DurationMs,
	}, nil
}

func textPatch(task model.Task, req Request) (NodePatch, error) {
	if req.OutputIndex != 0 {
		return NodePatch{}, invalid("invalid_params", "文本任务只能绑定 outputIndex 0")
	}
	text, storyboard, ok, unreadable := durableText(task.ResultJSON)
	if unreadable {
		return NodePatch{}, precondition("delivery_unreadable", "任务结果无法读取，不能绑定到画布")
	}
	if !ok {
		return NodePatch{}, precondition("output_not_ready", "文本任务还没有可绑定的结果")
	}
	return NodePatch{
		CanvasID:    req.CanvasID,
		NodeID:      req.NodeID,
		TaskID:      req.TaskID,
		OutputIndex: req.OutputIndex,
		EffectKey:   req.EffectKey,
		MediaType:   "text",
		Content:     text,
		Storyboard:  storyboard,
	}, nil
}

func isTextTask(task model.Task) bool {
	switch strings.TrimSpace(task.Type) {
	case "canvas_text", "text_replay":
		return true
	default:
		return false
	}
}

func assetResourceID(asset *model.Asset) string {
	if asset == nil {
		return ""
	}
	var payload map[string]any
	if json.Unmarshal([]byte(asset.PayloadJSON), &payload) != nil {
		return ""
	}
	if data, ok := payload["data"].(map[string]any); ok {
		for _, key := range []string{"storageKey", "url", "dataUrl"} {
			text, _ := data[key].(string)
			if id := assets.ResourceID(text); id != "" {
				return id
			}
		}
	}
	if cover, _ := payload["coverUrl"].(string); cover != "" {
		return assets.ResourceID(cover)
	}
	return ""
}

func durableText(resultJSON string) (text string, storyboard map[string]any, ok bool, unreadable bool) {
	if strings.TrimSpace(resultJSON) == "" {
		return "", nil, false, false
	}
	var payload map[string]any
	if json.Unmarshal([]byte(resultJSON), &payload) != nil {
		return "", nil, false, true
	}
	if value, has := payload["text"]; has {
		text, _ = value.(string)
		text = strings.TrimSpace(text)
	}
	if rows, has := payload["rows"]; has && rows != nil {
		storyboard = map[string]any{"rows": rows}
		if title, hasTitle := payload["title"]; hasTitle {
			storyboard["title"] = title
		}
	} else if nested, has := payload["storyboard"].(map[string]any); has {
		storyboard = nested
	}
	return text, storyboard, text != "" || storyboard != nil, false
}

func receiptFor(req Request, patch NodePatch, result NodeBindResult) Receipt {
	return Receipt{
		Applied:      true,
		CanvasID:     req.CanvasID,
		NodeID:       req.NodeID,
		TaskID:       req.TaskID,
		OutputIndex:  req.OutputIndex,
		EffectKey:    req.EffectKey,
		MediaType:    patch.MediaType,
		AssetID:      patch.AssetID,
		ResourceID:   patch.ResourceID,
		StorageKey:   patch.StorageKey,
		Content:      patch.Content,
		Revision:     result.Revision,
		AlreadyBound: patch.AlreadyBound,
		Node:         result.Node,
	}
}

func mapPortError(err error) error {
	if err == nil {
		return nil
	}
	var bindErr *Error
	if errors.As(err, &bindErr) {
		return bindErr
	}
	return err
}

func isRevisionConflict(err error) bool {
	var bindErr *Error
	return errors.As(err, &bindErr) && bindErr.Reason == "stale_revision"
}
