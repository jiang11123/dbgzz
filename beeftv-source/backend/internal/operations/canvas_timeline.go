package operations

import (
	"encoding/json"
	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/editing"
	"strings"
)

func registerCanvasTimelineOps(r *Registry) {
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.timeline.update", Summary: "修改当前画布时间线（裁剪、顺序、音量、字幕；仅用已关联素材，带 revision CAS）", Scope: ScopeCanvas,
		Params: timelineUpdateSchema(json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"expectedRevision":{"type":"integer","minimum":0},"timeline":{"type":"object","description":"时间线 v2；时间均为毫秒。所有可见 video/image 片段按 startMs 播放且不可重叠（跨轨也一样）；空隙补黑。音频、字幕可与视觉重叠。仅使用当前画布已关联的素材或已保存时间线中的资源。","properties":{"version":{"type":"integer","enum":[2]},"durationMs":{"type":"integer","minimum":0},"tracks":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","enum":["video","audio","subtitle","text","image"]},"visible":{"type":"boolean"},"muted":{"type":"boolean"},"label":{"type":"string"},"order":{"type":"integer"},"locked":{"type":"boolean"}},"required":["id","kind"]}},"clips":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","enum":["video","image","audio","subtitle"]},"nodeId":{"type":"string","description":"媒体片段对应当前画布节点；字幕无需 nodeId"},"directMedia":{"type":"object","description":"也可引用当前画布已关联的资源；不能传路径或任意 URL","properties":{"id":{"type":"string"},"assetId":{"type":"string"},"kind":{"type":"string","enum":["video","image","audio"]},"storageKey":{"type":"string","description":"resource:资源ID"}},"required":["id","kind","storageKey"]},"trackId":{"type":"string"},"startMs":{"type":"integer","minimum":0},"durationMs":{"type":"integer","minimum":1,"description":"播放及裁剪长度；sourceStartMs + durationMs 不得超过素材时长（静态图片除外）"},"sourceStartMs":{"type":"integer","minimum":0,"description":"媒体裁剪起点；默认 0"},"volume":{"type":"number","minimum":0,"description":"默认 1；0 为静音"},"fadeInMs":{"type":"integer","minimum":0,"description":"音频淡入时长；不改变画面"},"fadeOutMs":{"type":"integer","minimum":0,"description":"音频淡出时长；不改变画面"},"text":{"type":"string","description":"字幕内容；仅 kind=subtitle 使用"},"title":{"type":"string"},"subtitleEntryIndex":{"type":"integer"}},"required":["id","kind","trackId","startMs","durationMs"]}},"output":{"type":["object","null"],"description":"保存到工程的输出规格；省略保留已存规格，null清除，后续GUI和助手导出共用","properties":{"width":{"type":"integer","minimum":2},"height":{"type":"integer","minimum":2},"fps":{"type":"integer","minimum":1},"sampleRate":{"type":"integer","minimum":8000},"burnSubtitles":{"type":"boolean"}}}},"required":["version","tracks","clips","durationMs"]}},"required":["canvasId","expectedRevision","timeline"]}`)), Handler: opCanvasTimelineUpdate})
}

func timelineUpdateSchema(raw json.RawMessage) json.RawMessage {
	var schema map[string]any
	_ = json.Unmarshal(raw, &schema)
	schema["properties"].(map[string]any)["refreshNodeIds"] = map[string]any{
		"type": "array", "minItems": 1, "maxItems": 50, "uniqueItems": true,
		"items":       map[string]any{"type": "string", "minLength": 1},
		"description": "仅把已存在媒体片段替换为这些节点当前绑定的素材。保留全部字幕、时序、裁剪、音量、轨道和输出规格；新素材过短则拒绝，不自动改时长。与 timeline 二选一。局部重生成后优先用此参数。",
	}
	schema["required"] = []string{"canvasId", "expectedRevision"}
	schema["oneOf"] = []any{
		map[string]any{"required": []string{"timeline"}},
		map[string]any{"required": []string{"refreshNodeIds"}},
	}
	encoded, _ := json.Marshal(schema)
	return encoded
}

func opCanvasTimelineUpdate(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string           `json:"canvasId"`
		ExpectedRevision *int64           `json:"expectedRevision"`
		Timeline         *editing.Project `json:"timeline"`
		RefreshNodeIDs   []string         `json:"refreshNodeIds"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(params, &fields)
	_, hasTimeline := fields["timeline"]
	_, hasRefresh := fields["refreshNodeIds"]
	if strings.TrimSpace(args.CanvasID) == "" || args.ExpectedRevision == nil || *args.ExpectedRevision < 0 ||
		hasTimeline == hasRefresh || (args.Timeline == nil) == (args.RefreshNodeIDs == nil) {
		return nil, InvalidArg("invalid_params", "需要 canvasId、expectedRevision，且 timeline 与 refreshNodeIds 二选一")
	}
	raw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		return nil, AsError(err)
	}
	revision := canvasRevision(doc)
	if revision != *args.ExpectedRevision {
		return nil, Conflict("revision_conflict", "画布已经变化，请重新读取", map[string]any{"currentRevision": revision})
	}
	if args.RefreshNodeIDs != nil {
		if err := refreshTimelineSources(ctx, doc, args.RefreshNodeIDs); err != nil {
			return nil, err
		}
		return commitTimelineUpdate(ctx, args.CanvasID, *args.ExpectedRevision, doc)
	}
	if args.Timeline.Output == nil {
		var requested struct {
			Timeline map[string]json.RawMessage `json:"timeline"`
		}
		if err = json.Unmarshal(params, &requested); err != nil {
			return nil, InvalidArg("invalid_params", "timeline 必须是对象")
		}
		// An edit may replace tracks and clips without restating project output.
		// Explicit null clears the setting; omission retains only valid output.
		if _, present := requested.Timeline["output"]; !present {
			var saved struct {
				Output *editing.Options `json:"output"`
			}
			previous, marshalErr := json.Marshal(doc["timeline"])
			if marshalErr == nil && json.Unmarshal(previous, &saved) == nil && saved.Output != nil {
				if _, outputErr := editing.NormalizeOptions(*saved.Output); outputErr == nil {
					args.Timeline.Output = saved.Output
				}
			}
		}
	}
	sources, err := timelineSources(ctx, doc, args.Timeline)
	if err != nil {
		return nil, err
	}
	if _, err = editing.Compile(*args.Timeline, sources, editing.Options{}); err != nil {
		return nil, InvalidArg("invalid_timeline", err.Error())
	}
	// Encode the typed timeline; unknown fields can never introduce paths or URLs.
	timeline, err := json.Marshal(args.Timeline)
	if err != nil {
		return nil, AsError(err)
	}
	var value any
	if err = json.Unmarshal(timeline, &value); err != nil {
		return nil, AsError(err)
	}
	doc["timeline"] = value
	return commitTimelineUpdate(ctx, args.CanvasID, *args.ExpectedRevision, doc)
}

func commitTimelineUpdate(ctx *Context, canvasID string, revision int64, doc map[string]any) (any, error) {
	encoded, err := json.Marshal(doc)
	if err != nil {
		return nil, AsError(err)
	}
	summary, _, err := ctx.Domain.CommitUserCanvasDocument(ctx.UserID, canvasID, revision, encoded)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{"canvasId": canvasID, "revision": summary.Revision, "timelineUpdated": true}, nil
}

// Validate using the same ownership and render rules as a full edit, but write
// only the selected media references back into the original document.
func refreshTimelineSources(ctx *Context, doc map[string]any, nodeIDs []string) error {
	if len(nodeIDs) == 0 || len(nodeIDs) > 50 {
		return InvalidArg("invalid_params", "refreshNodeIds 需要1至50个不同节点")
	}
	selected := map[string]bool{}
	for _, id := range nodeIDs {
		if strings.TrimSpace(id) == "" || selected[id] {
			return InvalidArg("invalid_params", "refreshNodeIds 不能包含空节点或重复节点")
		}
		selected[id] = true
	}
	rawTimeline, ok := doc["timeline"].(map[string]any)
	if !ok {
		return InvalidArg("invalid_timeline", "当前画布没有可更新的时间线")
	}
	rawClips, ok := rawTimeline["clips"].([]any)
	if !ok {
		return InvalidArg("invalid_timeline", "当前时间线缺少片段")
	}
	raw, err := json.Marshal(rawTimeline)
	var project editing.Project
	if err != nil || json.Unmarshal(raw, &project) != nil {
		return InvalidArg("invalid_timeline", "当前时间线无法读取")
	}
	found := map[string]bool{}
	for i := range project.Clips {
		clip := &project.Clips[i]
		if selected[clip.NodeID] && clip.Kind != editing.KindSubtitle {
			clip.DirectMedia = nil
			found[clip.NodeID] = true
		}
	}
	if len(found) != len(selected) {
		return InvalidArg("timeline_node_not_used", "指定节点没有对应的媒体片段，未修改时间线")
	}
	sources, err := timelineSources(ctx, doc, &project)
	if err != nil {
		return err
	}
	if _, err := editing.Compile(project, sources, editing.Options{}); err != nil {
		return InvalidArg("invalid_timeline", err.Error())
	}
	for i, clip := range project.Clips {
		if selected[clip.NodeID] && clip.Kind != editing.KindSubtitle {
			rawClip, ok := rawClips[i].(map[string]any)
			if !ok {
				return InvalidArg("invalid_timeline", "时间线片段无法读取")
			}
			rawClip["directMedia"] = clip.DirectMedia
		}
	}
	return nil
}

func timelineSources(ctx *Context, doc map[string]any, project *editing.Project) ([]editing.SourceMeta, error) {
	nodes := map[string]map[string]any{}
	allowed := map[string]bool{}
	assetForResource := map[string]string{}
	for _, raw := range canvasNodes(doc) {
		if node, ok := raw.(map[string]any); ok {
			if id, ok := node["id"].(string); ok {
				nodes[id] = node
			}
			collectMediaResourceIDs(node, allowed)
			if metadata, ok := node["metadata"].(map[string]any); ok {
				if assetID, ok := metadata["assetId"].(string); ok && assetID != "" {
					ids := map[string]bool{}
					collectMediaResourceIDs(node, ids)
					for id := range ids {
						assetForResource[id] = assetID
					}
				}
			}
		}
	}
	// Direct resource references already saved in this owned document are also usable.
	var previous editing.Project
	if raw, err := json.Marshal(doc["timeline"]); err == nil && json.Unmarshal(raw, &previous) == nil {
		for _, clip := range previous.Clips {
			if id, ok := editing.MediaResourceID(clip); ok {
				allowed[id] = true
				if clip.DirectMedia.AssetID != "" {
					assetForResource[id] = clip.DirectMedia.AssetID
				}
			}
		}
	}
	sources := []editing.SourceMeta{}
	seen := map[string]bool{}
	for index := range project.Clips {
		clip := project.Clips[index]
		if clip.Kind == editing.KindSubtitle {
			continue
		}
		resourceID, direct := editing.MediaResourceID(clip)
		if clip.DirectMedia != nil && !direct {
			return nil, PermissionDenied("timeline_source_not_authorized", "时间线只接受已关联的资源引用")
		}
		if clip.NodeID != "" {
			node, ok := nodes[clip.NodeID]
			if !ok {
				return nil, PermissionDenied("node_not_in_canvas", "时间线节点不属于当前画布")
			}
			ids := map[string]bool{}
			collectMediaResourceIDs(node, ids)
			if direct {
				if !ids[resourceID] {
					return nil, PermissionDenied("timeline_source_not_authorized", "节点与时间线资源不一致")
				}
			} else {
				if len(ids) != 1 {
					return nil, InvalidArg("timeline_resource_required", "时间线节点须明确关联一个资源")
				}
				for id := range ids {
					resourceID = id
				}
			}
		} else if !direct {
			return nil, InvalidArg("timeline_resource_required", "时间线片段需要节点或资源引用")
		}
		if !allowed[resourceID] {
			return nil, PermissionDenied("timeline_source_not_authorized", "不能在时间线中加入未关联的资源")
		}
		resource, err := ctx.Domain.OwnedReadyResource(ctx.UserID, resourceID)
		if err != nil {
			return nil, mapDomainError(err)
		}
		if resource == nil {
			return nil, PreconditionFailed("timeline_source_not_ready", "时间线素材尚未就绪", nil)
		}
		assetID := assetForResource[resourceID]
		if assetID == "" {
			return nil, PreconditionFailed("timeline_asset_not_linked", "素材尚未关联素材库，请先同步", nil)
		}
		asset, err := ctx.Domain.OwnedAsset(ctx.UserID, assetID)
		if err != nil {
			return nil, mapDomainError(err)
		}
		if asset == nil {
			return nil, PermissionDenied("timeline_asset_not_owned", "素材不属于当前工作区")
		}
		if _, linked := assets.DocumentReferencedIDs(asset.PayloadJSON, map[string]struct{}{resourceID: {}})[resourceID]; !linked {
			return nil, PermissionDenied("timeline_asset_not_linked", "素材与资源引用不一致")
		}
		kind := ""
		switch {
		case strings.HasPrefix(resource.MimeType, "video/"):
			kind = editing.KindVideo
		case strings.HasPrefix(resource.MimeType, "audio/"):
			kind = editing.KindAudio
		case strings.HasPrefix(resource.MimeType, "image/"):
			kind = editing.KindImage
		}
		if kind == "" || (clip.Kind != kind && !(clip.Kind == editing.KindAudio && kind == editing.KindVideo)) {
			return nil, InvalidArg("timeline_source_kind", "时间线片段与素材类型不匹配")
		}
		project.Clips[index].DirectMedia = &editing.DirectMedia{ID: resourceID, AssetID: assetID, Kind: kind, StorageKey: "resource:" + resourceID}
		for _, id := range []string{clip.NodeID, resourceID, "resource:" + resourceID} {
			if id != "" && !seen[id] {
				sources = append(sources, editing.SourceMeta{ID: id, Kind: kind, DurationMs: resource.DurationMs})
				seen[id] = true
			}
		}
	}
	return sources, nil
}
