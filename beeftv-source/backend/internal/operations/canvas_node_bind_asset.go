package operations

import (
	"encoding/json"
	"strings"
)

func registerCanvasNodeBindAsset(r *Registry) {
	r.Register(Op{AssistantCanvas: true, ID: "canvas.node.bind_asset", Summary: "把已上传的素材库图片/视频/音频绑定到已有同类型参考节点；写入真实资源与素材身份，不生成不付费，再用 edge.create 连接生成节点", Scope: ScopeCanvas,
		Params: json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"canvasId":{"type":"string"},"nodeId":{"type":"string"},"assetId":{"type":"string"},"resourceId":{"type":"string","description":"可省略；素材包含多个资源时必填，只能选择该素材已有资源"},"expectedRevision":{"type":"integer","minimum":0}},"required":["canvasId","nodeId","assetId","expectedRevision"]}`), Handler: opCanvasNodeBindAsset})
}

func opCanvasNodeBindAsset(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string `json:"canvasId"`
		NodeID           string `json:"nodeId"`
		AssetID          string `json:"assetId"`
		ResourceID       string `json:"resourceId"`
		ExpectedRevision *int64 `json:"expectedRevision"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.NodeID) == "" || strings.TrimSpace(args.AssetID) == "" || args.ExpectedRevision == nil || *args.ExpectedRevision < 0 {
		return nil, InvalidArg("invalid_params", "画布、节点、素材和当前版本必填")
	}
	asset, err := ctx.Domain.OwnedAsset(ctx.UserID, args.AssetID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if asset == nil {
		return nil, NotFound("asset_not_found", "素材不存在")
	}
	ids, err := ReferencedMediaResourceIDs(json.RawMessage(asset.PayloadJSON))
	if err != nil {
		return nil, InvalidArg("invalid_asset", "素材资源记录无效")
	}
	if args.ResourceID == "" {
		if len(ids) != 1 {
			return nil, InvalidArg("ambiguous_asset_resource", "素材没有唯一资源，请选择该素材中的 resourceId")
		}
		args.ResourceID = ids[0]
	}
	linked := false
	for _, id := range ids {
		if id == args.ResourceID {
			linked = true
		}
	}
	if !linked {
		return nil, InvalidArg("asset_resource_mismatch", "资源不属于指定素材")
	}
	resource, err := ctx.Domain.OwnedReadyResource(ctx.UserID, args.ResourceID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if resource == nil {
		return nil, NotFound("resource_not_found", "素材资源不存在")
	}
	kind := asset.Kind
	if kind != "image" && kind != "video" && kind != "audio" {
		return nil, InvalidArg("unsupported_asset_kind", "只能绑定图片、视频或音频素材")
	}
	if !strings.HasPrefix(strings.ToLower(resource.MimeType), kind+"/") {
		return nil, InvalidArg("asset_resource_kind_mismatch", "素材类型与资源类型不一致")
	}
	canvasRaw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(canvasRaw, &doc); err != nil {
		return nil, AsError(err)
	}
	if revision := canvasRevision(doc); revision != *args.ExpectedRevision {
		return nil, Conflict("revision_conflict", "画布已变化，请重新读取", map[string]any{"currentRevision": revision})
	}
	node := findDocNode(doc, args.NodeID)
	if node == nil {
		return nil, NotFound("node_not_found", "节点不属于指定画布")
	}
	if node["type"] != kind {
		return nil, InvalidArg("node_kind_mismatch", "素材与参考节点类型不一致")
	}
	metadata, _ := node["metadata"].(map[string]any)
	if metadata == nil {
		metadata = map[string]any{}
		node["metadata"] = metadata
	}
	if taskID, _ := metadata["taskId"].(string); taskID != "" {
		return nil, PreconditionFailed("node_has_task", "请使用独立参考节点，不覆盖已有任务节点", nil)
	}
	metadata["assetId"] = asset.ID
	metadata["storageKey"] = "resource:" + resource.ID
	metadata["content"] = "/api/resources/" + resource.ID + "/file"
	metadata["nodeRole"] = "result"
	metadata["resultOrigin"] = "library"
	metadata["status"] = "success"
	metadata["mimeType"] = resource.MimeType
	metadata["bytes"] = resource.Size
	for _, key := range []string{"width", "height", "naturalWidth", "naturalHeight", "durationMs"} {
		delete(metadata, key)
	}
	if resource.Width > 0 {
		metadata["width"] = resource.Width
		metadata["naturalWidth"] = resource.Width
	}
	if resource.Height > 0 {
		metadata["height"] = resource.Height
		metadata["naturalHeight"] = resource.Height
	}
	if resource.DurationMs > 0 {
		metadata["durationMs"] = resource.DurationMs
	}
	delete(metadata, "previewContent")
	delete(metadata, "fileUpload")
	encoded, err := json.Marshal(doc)
	if err != nil {
		return nil, AsError(err)
	}
	summary, _, err := ctx.Domain.CommitUserCanvasDocument(ctx.UserID, args.CanvasID, *args.ExpectedRevision, encoded)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "assetId": asset.ID, "resourceId": resource.ID, "node": node, "revision": summary.Revision, "referenceBound": true}, nil
}
