package operations

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskbinding"
)

func opCanvasTaskBind(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID    string `json:"canvasId"`
		TaskID      string `json:"taskId"`
		NodeID      string `json:"nodeId"`
		OutputIndex int    `json:"outputIndex"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	receipt, err := taskbinding.Bind(&bindPorts{ctx: ctx}, ctx.UserID, taskbinding.Request{
		CanvasID:    args.CanvasID,
		TaskID:      args.TaskID,
		NodeID:      args.NodeID,
		OutputIndex: args.OutputIndex,
	})
	if err != nil {
		mapped := mapDomainError(err)
		if failure, ok := mapped.(*Error); ok && failure.Reason == "node_task_mismatch" {
			failure.Details = canvasBindConflictEvidence(ctx, args.CanvasID, args.NodeID, args.OutputIndex)
		}
		return nil, mapped
	}
	projected, err := projectCanvasTaskBindOutcome(ctx, args.CanvasID, args.NodeID, receiptMap(receipt))
	if err != nil {
		return nil, err
	}
	return sanitizeForClient(projected), nil
}

// The failed transaction still sees the node that refused this bind. Return
// only identities and flags so client diagnostics can retain that exact state.
func canvasBindConflictEvidence(ctx *Context, canvasID, nodeID string, outputIndex int) map[string]any {
	raw, err := ctx.Domain.UserCanvasProject(ctx.UserID, canvasID)
	if err != nil {
		return nil
	}
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return nil
	}
	node := findDocNode(doc, nodeID)
	metadata, _ := node["metadata"].(map[string]any)
	text := func(fields map[string]any, key string) string { value, _ := fields[key].(string); return value }
	hasMedia := canvas.NodeHasMedia(node)
	return map[string]any{"canvasBinding": map[string]any{
		"source": "server", "nodeId": nodeID, "nodePresent": node != nil, "nodeType": text(node, "type"),
		"nodeTaskId": text(metadata, "taskId"), "nodeClientOperationId": text(metadata, "taskClientOperationId"),
		"nodeStatus": text(metadata, "status"), "nodeHasMedia": hasMedia,
		"revision": canvasRevision(doc), "outputIndex": outputIndex,
	}}
}

func projectCanvasTaskBindReplay(ctx *Context, params json.RawMessage, stored any) (any, error) {
	var args struct {
		CanvasID string `json:"canvasId"`
		NodeID   string `json:"nodeId"`
		TaskID   string `json:"taskId"`
	}
	if json.Unmarshal(params, &args) != nil {
		return stored, nil
	}
	historical := cloneReceiptMap(stored)
	projected, err := projectCanvasTaskBindOutcome(ctx, args.CanvasID, args.NodeID, historical)
	if err != nil {
		return nil, err
	}
	return sanitizeForClient(projected), nil
}

func projectCanvasTaskBindOutcome(ctx *Context, canvasID, nodeID string, stored map[string]any) (map[string]any, error) {
	historical := historicalBindReceipt(stored)
	projected := map[string]any{
		"applied":       stored["applied"],
		"canvasId":      stored["canvasId"],
		"nodeId":        stored["nodeId"],
		"taskId":        stored["taskId"],
		"outputIndex":   stored["outputIndex"],
		"effectKey":     stored["effectKey"],
		"mediaType":     stored["mediaType"],
		"alreadyBound":  stored["alreadyBound"],
		"historical":    historical,
		"bindingStatus": "deleted",
	}
	if ctx == nil || ctx.Domain == nil {
		return projected, nil
	}
	raw, err := ctx.Domain.UserCanvasProject(ctx.UserID, strings.TrimSpace(canvasID))
	if err != nil {
		if isNotFoundError(err) {
			return projected, nil
		}
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, AsError(err)
	}
	projected["revision"] = canvasRevision(doc)
	projected["canvas"] = doc
	node := findDocNode(doc, strings.TrimSpace(nodeID))
	if node == nil {
		return projected, nil
	}
	projected["node"] = node
	historicalTaskID, _ := stored["taskId"].(string)
	if currentTaskID := nodeMetadataTaskID(node); currentTaskID != "" && strings.TrimSpace(historicalTaskID) != "" && currentTaskID != strings.TrimSpace(historicalTaskID) {
		projected["bindingStatus"] = "replaced"
		return projected, nil
	}
	projected["bindingStatus"] = "bound"
	copyCurrentGenerationFields(projected, node)
	return projected, nil
}

func historicalBindReceipt(stored map[string]any) map[string]any {
	out := cloneReceiptMap(stored)
	delete(out, "canvas")
	delete(out, "historical")
	delete(out, "bindingStatus")
	return out
}

func cloneReceiptMap(stored any) map[string]any {
	if stored == nil {
		return map[string]any{}
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		if typed, ok := stored.(map[string]any); ok {
			out := make(map[string]any, len(typed))
			for key, value := range typed {
				out[key] = value
			}
			return out
		}
		return map[string]any{}
	}
	var out map[string]any
	if json.Unmarshal(encoded, &out) != nil || out == nil {
		return map[string]any{}
	}
	return out
}

func nodeMetadataTaskID(node map[string]any) string {
	if node == nil {
		return ""
	}
	meta, _ := node["metadata"].(map[string]any)
	if meta == nil {
		return ""
	}
	value, _ := meta["taskId"].(string)
	return strings.TrimSpace(value)
}

func copyCurrentGenerationFields(projected map[string]any, node map[string]any) {
	if projected == nil || node == nil {
		return
	}
	meta, _ := node["metadata"].(map[string]any)
	if meta == nil {
		return
	}
	for _, key := range []string{"content", "storageKey", "assetId"} {
		if value, _ := meta[key].(string); strings.TrimSpace(value) != "" {
			projected[key] = value
		}
	}
}

func receiptMap(receipt taskbinding.Receipt) map[string]any {
	encoded, err := json.Marshal(receipt)
	if err != nil {
		return map[string]any{"applied": receipt.Applied, "canvasId": receipt.CanvasID, "nodeId": receipt.NodeID, "taskId": receipt.TaskID, "revision": receipt.Revision}
	}
	var out map[string]any
	if json.Unmarshal(encoded, &out) != nil {
		return map[string]any{"applied": receipt.Applied, "revision": receipt.Revision}
	}
	return out
}

type bindPorts struct {
	ctx *Context
}

func (p *bindPorts) Task(userID, taskID string) (*model.Task, error) {
	return p.ctx.Domain.WorkspaceTask(userID, taskID)
}

func (p *bindPorts) GenerationOutputs(taskID string) ([]localtask.CanonicalOutput, error) {
	return p.ctx.Domain.GenerationOutputs(taskID)
}

func (p *bindPorts) OwnedReadyResource(userID, resourceID string) (*model.Resource, error) {
	return p.ctx.Domain.OwnedReadyResource(userID, resourceID)
}

func (p *bindPorts) OwnedAsset(userID, assetID string) (*model.Asset, error) {
	return p.ctx.Domain.OwnedAsset(userID, assetID)
}

func (p *bindPorts) BindExistingNode(userID string, patch taskbinding.NodePatch) (taskbinding.NodeBindResult, error) {
	result, err := p.ctx.Domain.BindExistingCanvasNode(userID, canvas.TaskOutputBind{
		CanvasID:    patch.CanvasID,
		NodeID:      patch.NodeID,
		TaskID:      patch.TaskID,
		OutputIndex: patch.OutputIndex,
		EffectKey:   patch.EffectKey,
		MediaType:   patch.MediaType,
		AssetID:     patch.AssetID,
		ResourceID:  patch.ResourceID,
		StorageKey:  patch.StorageKey,
		Content:     patch.Content,
		MimeType:    patch.MimeType,
		Bytes:       patch.Bytes,
		Width:       patch.Width,
		Height:      patch.Height,
		DurationMs:  patch.DurationMs,
		Storyboard:  patch.Storyboard,
	})
	if err != nil {
		return taskbinding.NodeBindResult{}, err
	}
	return taskbinding.NodeBindResult{Revision: result.Revision, Node: result.Node}, nil
}

func bindEffectKey(params json.RawMessage) string {
	var args struct {
		TaskID      string `json:"taskId"`
		NodeID      string `json:"nodeId"`
		OutputIndex int    `json:"outputIndex"`
	}
	if json.Unmarshal(params, &args) != nil {
		return ""
	}
	taskID := strings.TrimSpace(args.TaskID)
	nodeID := strings.TrimSpace(args.NodeID)
	if taskID == "" || nodeID == "" {
		return ""
	}
	return localtask.AttachNodeEffectKey(taskID, nodeID, args.OutputIndex)
}
