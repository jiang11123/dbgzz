package operations

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/canvas/capability"
)

func registerCanvasNodeConfigureOps(r *Registry) {
	properties := map[string]any{}
	for _, kind := range []string{"image", "video", "audio"} {
		descriptor, _ := capability.BuiltinRegistry().Resolve(kind)
		for name, field := range descriptor.PatchFields {
			if name == "title" || name == "content" {
				continue
			}
			if previous, exists := properties[name]; exists {
				previous.(map[string]any)["description"] = previous.(map[string]any)["description"].(string) + "、" + kind
				continue
			}
			properties[name] = map[string]any{"type": field.Kind, "description": field.Description + "；适用 " + kind}
		}
	}
	properties["count"] = map[string]any{"type": "integer", "minimum": 1, "maximum": 8, "description": "仅 image"}
	for _, name := range []string{"transparentBackground", "generateAudio", "watermark"} {
		properties[name].(map[string]any)["enum"] = []string{"true", "false"}
	}
	params, _ := json.Marshal(map[string]any{"type": "object", "additionalProperties": false,
		"properties": map[string]any{"canvasId": map[string]any{"type": "string"}, "nodeId": map[string]any{"type": "string"},
			"kind": map[string]any{"type": "string", "enum": []string{"image", "video", "audio"}}, "expectedRevision": map[string]any{"type": "integer", "minimum": 1},
			"patch": map[string]any{"type": "object", "additionalProperties": false, "minProperties": 1, "properties": properties}},
		"required": []string{"canvasId", "nodeId", "kind", "expectedRevision", "patch"}})
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.node.configure", Summary: "设置已有媒体节点的生成草稿参数；不生成、不扣费，不改任务或现有成品", Scope: ScopeCanvas, Params: params, Handler: opCanvasNodeConfigure})
}

func opCanvasNodeConfigure(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string                     `json:"canvasId"`
		NodeID           string                     `json:"nodeId"`
		Kind             string                     `json:"kind"`
		ExpectedRevision int64                      `json:"expectedRevision"`
		Patch            map[string]json.RawMessage `json:"patch"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if args.CanvasID == "" || args.NodeID == "" || args.ExpectedRevision <= 0 || len(args.Patch) == 0 {
		return nil, InvalidArg("invalid_params", "需要画布、节点、类型、当前版本和参数")
	}
	if args.Kind != "image" && args.Kind != "video" && args.Kind != "audio" {
		return nil, InvalidArg("unsupported_node_kind", "仅媒体生成节点支持参数配置")
	}
	canvasRaw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(canvasRaw, &doc); err != nil {
		return nil, AsError(err)
	}
	if revision := canvasRevision(doc); revision != args.ExpectedRevision {
		return nil, Conflict("revision_conflict", "画布已变化，请重新读取", map[string]any{"currentRevision": revision})
	}
	node := findDocNode(doc, args.NodeID)
	if node == nil {
		return nil, NotFound("node_not_found", "节点不在当前画布")
	}
	if node["type"] != args.Kind {
		return nil, InvalidArg("node_kind_mismatch", "参数类型与目标节点不一致")
	}
	patch, err := resolveGenerationDraft(ctx, args.Kind, args.Patch)
	if err != nil {
		return nil, err
	}
	if _, err := ctx.Domain.UpdateUserCanvasNodeFields(ctx.UserID, args.CanvasID, args.NodeID, patch, args.ExpectedRevision); err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "node": findDocNode(doc, args.NodeID), "draftConfigured": true}
	})
}

// Single draft validator for a node edit and storyboard production preparation.
func resolveGenerationDraft(ctx *Context, kind string, raw map[string]json.RawMessage) (map[string]any, error) {
	descriptor, _ := capability.BuiltinRegistry().Resolve(kind)
	patch := map[string]any{}
	for name, value := range raw {
		field, ok := descriptor.PatchFields[name]
		if !ok || name == "title" || name == "content" {
			return nil, InvalidArg("unsupported_field", "该类型不支持参数 "+name)
		}
		if name == "count" {
			var count int
			if err := json.Unmarshal(value, &count); err != nil || count < 1 || count > 8 {
				return nil, InvalidArg("invalid_parameter", "count 必须是 1..8 的整数")
			}
			patch[name] = float64(count)
			continue
		}
		var text string
		if string(value) == "null" || json.Unmarshal(value, &text) != nil || len([]rune(text)) > field.MaxRunes {
			return nil, InvalidArg("invalid_parameter", name+" 必须是长度有限的字符串")
		}
		if err := validateDraftValue(name, text); err != nil {
			return nil, err
		}
		patch[name] = text
	}
	if selected, exists := patch["model"]; exists {
		choice, err := ctx.Domain.ResolveAssistantGenerationModel(kind, selected.(string))
		if err != nil {
			return nil, mapDomainError(err)
		}
		if choice.KindMismatch {
			return nil, InvalidArg("generation_model_kind_mismatch", "所选模型不支持该媒体类型")
		}
		if choice.ModelKey == "" || choice.Display == "" {
			return nil, PreconditionFailed("generation_model_unavailable", "所选模型当前不可用", nil)
		}
		patch["model"] = choice.ModelKey
	}
	return patch, nil
}

func validateDraftValue(name, value string) error {
	invalid := func() error { return InvalidArg("invalid_parameter", name+" 的值无效") }
	switch name {
	case "generateAudio", "watermark", "transparentBackground":
		if value != "true" && value != "false" {
			return invalid()
		}
	case "seconds", "audioSpeed", "audioPitch", "audioVolume":
		number, err := strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
			return invalid()
		}
		if (name == "seconds" && (number <= 0 || number > 600)) || (name == "audioSpeed" && (number < 0.25 || number > 4)) ||
			(name == "audioPitch" && (number < -12 || number > 12)) || (name == "audioVolume" && (number < 0 || number > 1)) {
			return invalid()
		}
	case "audioFormat":
		if !strings.Contains("|mp3|wav|pcm|flac|aac|opus|ogg|m4a|", "|"+value+"|") {
			return invalid()
		}
	case "size", "quality", "vquality", "audioVoice":
		if strings.TrimSpace(value) == "" {
			return invalid()
		}
	}
	return nil
}
