package operations

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/canvas/capability"
)

func registerStoryboardPreparation(r *Registry) {
	properties := map[string]any{
		"canvasId": map[string]any{"type": "string"}, "nodeId": map[string]any{"type": "string", "description": "已有分镜脚本节点"},
		"expectedRevision": map[string]any{"type": "integer", "minimum": 1},
		"rowIds":           map[string]any{"type": "array", "minItems": 1, "maxItems": 8, "items": map[string]any{"type": "string"}},
		"script": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"title", "rows"}, "properties": map[string]any{
			"title": map[string]any{"type": "string", "minLength": 1},
			"rows":  map[string]any{"type": "array", "minItems": 1, "maxItems": 8, "items": map[string]any{"type": "object", "additionalProperties": false, "properties": storyboardRowFieldSchemas}},
		}, "description": "新作品可直接提交分镜正文，一次创建脚本、分镜行与配置好的首帧/视频节点；与 nodeId/rowIds 二选一，失败全部回滚"},
		"referenceNodeIds": map[string]any{"type": "array", "maxItems": 4, "items": map[string]any{"type": "string"}, "description": "同画布角色或风格图片，仅连接到各首帧图片节点；视频只连接自己的首帧"},
	}
	for _, kind := range []string{"image", "video"} {
		descriptor, _ := capability.BuiltinRegistry().Resolve(kind)
		fields := map[string]any{}
		for name, field := range descriptor.PatchFields {
			if name == "title" || name == "content" || name == "seconds" || name == "count" {
				continue
			}
			fields[name] = map[string]any{"type": field.Kind, "description": field.Description}
		}
		if kind == "video" {
			fields["generateAudio"].(map[string]any)["enum"] = []string{"true", "false"}
		}
		required := []string{"model"}
		if kind == "video" {
			required = append(required, "generateAudio")
		}
		properties[kind] = map[string]any{"type": "object", "additionalProperties": false, "properties": fields, "required": required, "description": "本批节点共同生成参数；省略则不创建该类型。视频时长采用每行 durationSeconds，提示词直接采用分镜原文；视频必须明确是否生成声音"}
	}
	params, _ := json.Marshal(map[string]any{"type": "object", "additionalProperties": false, "properties": properties,
		"required": []string{"canvasId", "expectedRevision"}})
	r.Register(Op{ID: "canvas.script.prepare", Summary: "一次准备分镜与配置好的首帧/视频草稿；新作品直接传 script 正文，已有分镜传 nodeId/rowIds。绑定分镜、连接参考图并按镜头排布，不开始生成；已有绑定拒绝覆盖", Scope: ScopeCanvas, ReplaySafe: true, AssistantCanvas: true, Params: params, Handler: opStoryboardPrepare})
}

func opStoryboardPrepare(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string                     `json:"canvasId"`
		NodeID           string                     `json:"nodeId"`
		ExpectedRevision int64                      `json:"expectedRevision"`
		RowIDs           []string                   `json:"rowIds"`
		ReferenceNodeIDs []string                   `json:"referenceNodeIds"`
		Image            map[string]json.RawMessage `json:"image"`
		Video            map[string]json.RawMessage `json:"video"`
		Script           *canvas.StoryboardDraft    `json:"script"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || args.ExpectedRevision <= 0 || (args.Script == nil && strings.TrimSpace(args.NodeID) == "") {
		return nil, InvalidArg("invalid_params", "需要画布、分镜节点和当前版本")
	}
	if args.Script != nil && (args.NodeID != "" || len(args.RowIDs) > 0 || strings.TrimSpace(args.Script.Title) == "" || len(args.Script.Rows) < 1 || len(args.Script.Rows) > 8) {
		return nil, InvalidArg("invalid_params", "新分镜需要名称和1至8行正文，不能同时指定已有分镜")
	}
	input := canvas.StoryboardPreparation{Script: args.Script, RowIDs: args.RowIDs, ReferenceNodeIDs: args.ReferenceNodeIDs}
	for _, item := range []struct {
		kind   string
		raw    map[string]json.RawMessage
		target *map[string]any
	}{{"image", args.Image, &input.Image}, {"video", args.Video, &input.Video}} {
		if item.raw == nil {
			continue
		}
		var selected string
		if json.Unmarshal(item.raw["model"], &selected) != nil || strings.TrimSpace(selected) == "" {
			return nil, InvalidArg("invalid_parameter", "请选择明确的生成模型")
		}
		if _, exists := item.raw["seconds"]; exists {
			return nil, InvalidArg("invalid_parameter", "视频时长请修改对应分镜行")
		}
		if _, exists := item.raw["count"]; exists {
			return nil, InvalidArg("invalid_parameter", "每个分镜创建一张首帧")
		}
		if item.kind == "video" {
			if _, exists := item.raw["generateAudio"]; !exists {
				return nil, InvalidArg("invalid_parameter", "请根据作品需要明确选择是否生成声音")
			}
		}
		patch, err := resolveGenerationDraft(ctx, item.kind, item.raw)
		if err != nil {
			return nil, err
		}
		*item.target = patch
	}
	_, prepared, err := ctx.Domain.PrepareUserCanvasStoryboard(ctx.UserID, args.CanvasID, args.NodeID, input, args.ExpectedRevision)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if prepared.ScriptNodeID != "" {
		args.NodeID = prepared.ScriptNodeID
	}
	return canvasWriteResult(ctx, args.CanvasID, func(map[string]any) map[string]any {
		return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "created": prepared.Created, "createdEdgeIds": prepared.CreatedEdgeIDs, "shots": prepared.Shots}
	})
}
