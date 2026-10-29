package operations

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/canvas"
)

// storyboardRowFieldSchemas 是分镜行可写字段的白名单（与 canvas.StoryboardRowDraft 一一对应）。
// append 与 update 的 JSON Schema 共用这份字段表，避免两处定义漂移。
var storyboardRowFieldSchemas = map[string]map[string]any{
	"durationSeconds":       {"type": "number", "minimum": canvas.StoryboardMinShotSeconds, "maximum": canvas.StoryboardMaxShotSeconds, "description": "镜头时长（秒），缺省 6"},
	"plotDescription":       {"type": "string", "description": "本镜剧情描述"},
	"dialogue":              {"type": "string", "description": "本镜台词"},
	"narrativeIntent":       {"type": "string", "description": "叙事意图"},
	"viewerPOV":             {"type": "string", "description": "观众视角"},
	"performanceBlocking":   {"type": "string", "description": "表演与走位"},
	"shotSize":              {"type": "string", "description": "景别（远景/全景/中景/近景/特写等）"},
	"emotion":               {"type": "string", "description": "情绪基调"},
	"lightingAndAtmosphere": {"type": "string", "description": "灯光与氛围"},
	"audioEffects":          {"type": "string", "description": "音效要求"},
	"camera":                {"type": "string", "description": "机位与焦段"},
	"motion":                {"type": "string", "description": "镜头运动"},
	"timeBeats":             {"type": "string", "description": "时间节拍"},
	"imageGenerationPrompt": {"type": "string", "description": "首帧图片生成提示词"},
	"videoMotionPrompt":     {"type": "string", "description": "视频运动提示词"},
	"mustHave":              {"type": "array", "items": map[string]any{"type": "string"}, "description": "画面必须出现的要素"},
	"optionalDetails":       {"type": "array", "items": map[string]any{"type": "string"}, "description": "可选细节"},
	"continuityOut":         {"type": "string", "description": "本镜结束时保留到下一镜的连续性要素"},
	"negativePrompt":        {"type": "string", "description": "反向提示词"},
}

// storyboardTargetSchema 组装定位参数（canvasId/nodeId/expectedRevision + 一个批次字段）。
func storyboardTargetSchema(field string, itemSchema map[string]any, required []string) json.RawMessage {
	properties := map[string]any{
		"canvasId":         map[string]any{"type": "string"},
		"nodeId":           map[string]any{"type": "string"},
		"expectedRevision": map[string]any{"type": "integer", "description": "读取画布时拿到的 revision，写入做 CAS 校验"},
		field:              itemSchema,
	}
	encoded, err := json.Marshal(map[string]any{
		"type": "object", "properties": properties,
		"required": append([]string{"canvasId", "nodeId", "expectedRevision"}, required...),
	})
	if err != nil {
		return json.RawMessage(`{"type":"object"}`)
	}
	return encoded
}

func storyboardRowsAppendSchema() json.RawMessage {
	return storyboardTargetSchema("rows", map[string]any{
		"type": "array", "minItems": 1, "maxItems": 32,
		"items": map[string]any{
			"type":        "object",
			"properties":  storyboardRowFieldSchemas,
			"description": "行 ID 与镜号由服务端分配（镜号从现有行数 +1 递增）",
		},
	}, []string{"rows"})
}

func storyboardRowUpdateSchema() json.RawMessage {
	return storyboardTargetSchema("patches", map[string]any{
		"type": "array", "minItems": 1, "maxItems": 32,
		"items": map[string]any{
			"type": "object",
			"properties": func() map[string]any {
				properties := map[string]any{"rowId": map[string]any{"type": "string"},
					"imageNodeId": map[string]any{"type": "string", "description": "把同一画布的 image 节点绑定为本行首帧图片；空字符串解除绑定。本行只保留一条指向它的产出连线"},
					"videoNodeId": map[string]any{"type": "string", "description": "把同一画布的 video 节点绑定为本行镜头视频；空字符串解除绑定。本行只保留一条指向它的产出连线"},
				}
				for name, schema := range storyboardRowFieldSchemas {
					properties[name] = schema
				}
				return properties
			}(),
			"required":    []string{"rowId"},
			"description": "只覆盖给出的字段；任何一个 rowId 不存在、绑定节点不在本画布或类型不符则整批拒绝",
		},
	}, []string{"patches"})
}

func storyboardRowRemoveSchema() json.RawMessage {
	return storyboardTargetSchema("rowIds", map[string]any{
		"type": "array", "minItems": 1, "maxItems": 32,
		"items":       map[string]any{"type": "string"},
		"description": "删除后剩余行镜号自动重排为 1..n；任何一个行 ID 不存在则整批拒绝",
	}, []string{"rowIds"})
}

func opStoryboardRowsAppend(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string                      `json:"canvasId"`
		NodeID           string                      `json:"nodeId"`
		ExpectedRevision int64                       `json:"expectedRevision"`
		Rows             []canvas.StoryboardRowDraft `json:"rows"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.NodeID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 与 nodeId 必填")
	}
	_, created, err := ctx.Domain.AppendUserCanvasStoryboardRows(ctx.UserID, args.CanvasID, args.NodeID, args.Rows, args.ExpectedRevision)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "created": created, "rowCount": len(docStoryboardRows(doc, args.NodeID))}
	})
}

func opStoryboardRowUpdate(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string                      `json:"canvasId"`
		NodeID           string                      `json:"nodeId"`
		ExpectedRevision int64                       `json:"expectedRevision"`
		Patches          []canvas.StoryboardRowPatch `json:"patches"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.NodeID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 与 nodeId 必填")
	}
	_, update, err := ctx.Domain.UpdateUserCanvasStoryboardRows(ctx.UserID, args.CanvasID, args.NodeID, args.Patches, args.ExpectedRevision)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "updated": update.Updated, "rowCount": len(docStoryboardRows(doc, args.NodeID)),
			"createdEdgeIds": update.CreatedEdgeIDs, "deletedEdgeIds": update.DeletedEdgeIDs}
	})
}

func opStoryboardRowRemove(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string   `json:"canvasId"`
		NodeID           string   `json:"nodeId"`
		ExpectedRevision int64    `json:"expectedRevision"`
		RowIDs           []string `json:"rowIds"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.NodeID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 与 nodeId 必填")
	}
	before, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var previous map[string]any
	if err := json.Unmarshal(before, &previous); err != nil {
		return nil, AsError(err)
	}
	_, remaining, err := ctx.Domain.RemoveUserCanvasStoryboardRows(ctx.UserID, args.CanvasID, args.NodeID, args.RowIDs, args.ExpectedRevision)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		current := map[string]bool{}
		connections, _ := doc["connections"].([]any)
		for _, raw := range connections {
			if edge, ok := raw.(map[string]any); ok {
				if id, ok := edge["id"].(string); ok {
					current[id] = true
				}
			}
		}
		deleted, _ := removeCanvasEdges(previous, func(edge map[string]any) bool { id, _ := edge["id"].(string); return !current[id] })
		return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "removed": len(args.RowIDs), "rowCount": remaining, "deletedEdgeIds": deleted}
	})
}

// docStoryboardRows 从写入后的画布文档里取目标分镜节点的当前行数，用于回执里的行数投影。
func docStoryboardRows(doc map[string]any, nodeID string) []any {
	for _, rawNode := range canvasNodes(doc) {
		node, ok := rawNode.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := node["id"].(string); id != nodeID {
			continue
		}
		metadata, _ := node["metadata"].(map[string]any)
		if metadata == nil {
			return nil
		}
		storyboard, _ := metadata["storyboard"].(map[string]any)
		if storyboard == nil {
			return nil
		}
		rows, _ := storyboard["rows"].([]any)
		return rows
	}
	return nil
}
