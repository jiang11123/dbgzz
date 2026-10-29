package operations

import (
	"context"
	"encoding/json"
	"strings"
)

// MediaReviewer performs one bounded inference over bytes already authorized by
// the media operation. It has no tools, project writes, or recovery loop.
type MediaReviewer interface {
	ReviewMedia(context.Context, MediaPart, string) (MediaReviewObservation, error)
}

type MediaReviewObservation struct {
	Model     string          `json:"model"`
	RequestID string          `json:"requestId,omitempty"`
	Text      string          `json:"observations"`
	Usage     json.RawMessage `json:"usage,omitempty"`
}

type mediaReviewArgs struct {
	CanvasID        string `json:"canvasId"`
	NodeID          string `json:"nodeId,omitempty"`
	AssetID         string `json:"assetId,omitempty"`
	ResourceID      string `json:"resourceId,omitempty"`
	ExpectedVersion string `json:"expectedVersion"`
	StartMs         int64  `json:"startMs"`
	EndMs           int64  `json:"endMs"`
	Mode            string `json:"mode,omitempty"`
	Question        string `json:"question"`
}

func registerMediaReview(r *Registry) {
	r.Register(Op{ID: "media.review", AssistantCanvas: true, ReadOnly: true, ReplayUnsafe: true, Scope: ScopeCanvas,
		Summary: "用单独配置的多模态审片模型检查已关联影音的指定区间（最多15秒），返回观察和用量，可能收费。mode默认video，包含原音轨；独立音频用audio。先用media.overview取得版本。问题应来自用户要求，不预填正确答案或已知缺陷。结果是模型观察，不是整片合格证明；失败或中断不自动重发。未配置时明确不可用。",
		Params:  json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"canvasId":{"type":"string"},"nodeId":{"type":"string"},"assetId":{"type":"string"},"resourceId":{"type":"string","description":"目标关联多个资源时，指定其中一个 resourceId；不能读取未关联资源。"},"expectedVersion":{"type":"string","minLength":1},"startMs":{"type":"integer","minimum":0},"endMs":{"type":"integer","minimum":1},"mode":{"type":"string","enum":["video","audio"]},"question":{"type":"string","minLength":1,"maxLength":4000}},"required":["canvasId","expectedVersion","startMs","endMs","question"]}`), Handler: runMediaReview})
}

func runMediaReview(ctx *Context, raw json.RawMessage) (any, error) {
	var args mediaReviewArgs
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.Question) == "" || len([]rune(args.Question)) > 4000 || args.StartMs < 0 || args.EndMs <= args.StartMs || args.EndMs-args.StartMs > 15000 || strings.TrimSpace(args.ExpectedVersion) == "" {
		return nil, InvalidArg("invalid_media_review", "请提供素材版本、明确的15秒以内区间和审查问题")
	}
	if args.Mode == "" {
		args.Mode = "video"
	}
	if args.Mode != "video" && args.Mode != "audio" {
		return nil, InvalidArg("invalid_media_mode", "mode 必须是 video 或 audio")
	}
	reviewer, ok := ctx.Domain.(MediaReviewer)
	if !ok {
		return nil, Unsupported("media_review_unavailable", "当前工作区未配置审片模型")
	}
	params, _ := json.Marshal(mediaArgs{CanvasID: args.CanvasID, NodeID: args.NodeID, AssetID: args.AssetID, ResourceID: args.ResourceID, ExpectedVersion: args.ExpectedVersion, StartMs: args.StartMs, EndMs: args.EndMs, Mode: args.Mode})
	value, err := runMedia(ctx, "media.inspect", params)
	if err != nil {
		return nil, err
	}
	media := value.(MediaResult)
	mime := "video/mp4"
	if args.Mode == "audio" {
		mime = "audio/wav"
	}
	if len(media.Content) != 1 || media.Content[0].MimeType != mime {
		if args.Mode == "audio" {
			return nil, InvalidArg("media_review_requires_audio", "审片工具需要音频素材")
		}
		return nil, InvalidArg("media_review_requires_video", "审片工具需要视频素材")
	}
	part := media.Content[0]
	observation, err := reviewer.ReviewMedia(ctx.Context, part, args.Question)
	if err != nil {
		return nil, err
	}
	note := "指定片段已交给审片模型；观察可能有遗漏，需与原始要求及可见画面对照。时间位置以截取片段起点为0，加上source.startMs后才是原素材位置。"
	if args.Mode == "audio" {
		note = "指定音频片段已交给审片模型；观察可能有遗漏，需与原始要求及实际声音对照，不表示主模型亲自听取。时间位置以截取片段起点为0，加上source.startMs后才是原素材位置。"
	}
	return map[string]any{"source": media.Source, "durationMs": media.DurationMs, "hasAudio": media.HasAudio, "mediaSHA256": part.SHA256, "review": observation, "note": note}, nil
}
