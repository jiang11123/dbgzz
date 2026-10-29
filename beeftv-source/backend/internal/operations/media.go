package operations

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/editing"
)

// MediaSourceOpener is optional: domain implementations must open only owned,
// ready resource bytes. No path or URL received from a model reaches ffmpeg.
type MediaSourceOpener interface {
	OpenMediaResource(context.Context, string, string) (io.ReadCloser, error)
}

type MediaSource struct {
	CanvasID      string `json:"canvasId"`
	NodeID        string `json:"nodeId,omitempty"`
	AssetID       string `json:"assetId,omitempty"`
	ResourceID    string `json:"resourceId"`
	Version       string `json:"version"`
	StartMs       int64  `json:"startMs"`
	EndMs         int64  `json:"endMs"`
	TimestampKind string `json:"timestampKind,omitempty"`
}

type MediaPart struct {
	Type     string      `json:"type"`
	MimeType string      `json:"mimeType"`
	Data     string      `json:"data"`
	SHA256   string      `json:"sha256"`
	Source   MediaSource `json:"source"`
}

type MediaResult struct {
	Source           MediaSource            `json:"source"`
	DurationMs       int64                  `json:"durationMs"`
	HasVideo         bool                   `json:"hasVideo"`
	HasAudio         bool                   `json:"hasAudio"`
	Content          []MediaPart            `json:"content"`
	BlackIntervals   []MediaInterval        `json:"blackIntervals,omitempty"`
	SilenceIntervals []MediaInterval        `json:"silenceIntervals,omitempty"`
	SilenceDetection *MediaSilenceDetection `json:"silenceDetection,omitempty"`
	MeanDB           *float64               `json:"meanDb,omitempty"`
	PeakDB           *float64               `json:"peakDb,omitempty"`
	Note             string                 `json:"note,omitempty"`
	Evidence         []string               `json:"evidence,omitempty"`
}

type MediaSilenceDetection struct {
	NoiseDB           float64 `json:"noiseDb"`
	MinimumDurationMs int64   `json:"minimumDurationMs"`
	TimestampKind     string  `json:"timestampKind"`
}

type MediaInterval struct {
	StartMs int64 `json:"startMs"`
	EndMs   int64 `json:"endMs"`
}

type mediaArgs struct {
	CanvasID        string                `json:"canvasId"`
	NodeID          string                `json:"nodeId"`
	AssetID         string                `json:"assetId"`
	ResourceID      string                `json:"resourceId"`
	ExpectedVersion string                `json:"expectedVersion"`
	StartMs         int64                 `json:"startMs"`
	EndMs           int64                 `json:"endMs"`
	Mode            string                `json:"mode"`
	Evidence        *mediaEvidenceRequest `json:"evidence,omitempty"`
}

type mediaEvidenceRequest struct {
	StartMs *int64   `json:"startMs"`
	EndMs   *int64   `json:"endMs"`
	Modes   []string `json:"modes"`
	Checks  bool     `json:"checks"`
}

const mediaEvidenceSchema = `{"type":"object","description":"从同一份媒体字节一次读取明确区间的实际证据；每次最多15秒，不代表质量通过。静态帧不能替代连续视频或声音。","properties":{"startMs":{"type":"integer","minimum":0},"endMs":{"type":"integer","minimum":1},"modes":{"type":"array","minItems":1,"maxItems":3,"uniqueItems":true,"items":{"type":"string","enum":["frames","video","audio"]}},"checks":{"type":"boolean","description":"同时检测该区间的黑场、音量与静音；不能判断声音内容。"}},"required":["startMs","endMs","modes"],"additionalProperties":false}`

// ValidateMediaReference shares the owned-node/asset linkage checks with chat
// admission. Client-supplied resource IDs never grant access on their own.
func ValidateMediaReference(domain Domain, userID, canvasID, nodeID, assetID, resourceID string) (string, error) {
	id, err := resolveMediaResource(&Context{Domain: domain, UserID: userID}, mediaArgs{
		CanvasID: canvasID, NodeID: nodeID, AssetID: assetID, ResourceID: resourceID,
	})
	if err != nil {
		return "", err
	}
	resource, err := domain.OwnedReadyResource(userID, id)
	if err != nil {
		return "", err
	}
	return resource.MimeType, nil
}

func registerMediaOps(r *Registry) {
	registerMediaReview(r)
	summaries := map[string]string{
		"media.overview": "获取已关联媒体的版本、时长与静态预览；概要不能替代连续视频或声音内容审查。已知15秒以内区间可用 evidence 一次读取真实 frames/video/audio 及客观检测。",
		"media.inspect":  "实际读取指定区间，每次最多 15 秒：frames 看静态截图，video 看连续原生视频，audio 听原生音频；按问题选择，不把抽帧当作完整影音审查。",
		"media.check":    "客观测量指定区间的黑屏、音量与静音停顿（固定 -35 dB、最少 120 ms，返回原素材坐标）；音量与停顿不能判断声音内容。停顿仅是候选切点，随后用 media.inspect audio 裁剪并实际听取确认，不能当作词时间戳或语义切点，不能替代实际查看和听取。",
	}
	for _, id := range []string{"media.overview", "media.inspect", "media.check"} {
		operation := id
		required := `["canvasId"]`
		if operation != "media.overview" {
			required = `["canvasId","expectedVersion"]`
		}
		properties := ""
		if operation == "media.overview" {
			properties = `,"evidence":` + mediaEvidenceSchema
		}
		r.Register(Op{AssistantCanvas: true, ID: operation, Summary: summaries[operation], ReadOnly: true, Scope: ScopeCanvas,
			Params:  json.RawMessage(fmt.Sprintf(`{"type":"object","properties":{"canvasId":{"type":"string"},"nodeId":{"type":"string"},"assetId":{"type":"string"},"resourceId":{"type":"string"},"expectedVersion":{"type":"string","minLength":1,"description":"先调用 media.overview，使用返回的 version；inspect 和 check 必填，不猜版本。"},"startMs":{"type":"integer","minimum":0},"endMs":{"type":"integer","minimum":0},"mode":{"type":"string","description":"frames：离散静态截图，用于构图与画面内容，不能判断连续运动或声音；video：连续原生视频片段，用于运镜、动作、转场与音画关系，保留可用音轨；audio：原生音频片段，用于说话、对白、音乐和声音内容。按检查目标选择；inspect 每次最多 15 秒。","enum":["frames","video","audio"]}%s},"required":%s}`, properties, required)),
			Handler: func(ctx *Context, raw json.RawMessage) (any, error) { return runMedia(ctx, operation, raw) }})
	}
}

func resolveMediaResource(ctx *Context, args mediaArgs) (string, error) {
	if strings.TrimSpace(args.CanvasID) == "" || (args.NodeID == "") == (args.AssetID == "") {
		return "", InvalidArg("invalid_media_target", "指定 canvasId 和一个 nodeId 或 assetId")
	}
	// Read the owned canvas even for asset targets; scope authorization is enforced
	// by the registry before this function, not by model-provided claims.
	raw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return "", mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", AsError(err)
	}
	var target any
	if args.NodeID != "" {
		for _, candidate := range canvasNodes(doc) {
			if node, ok := candidate.(map[string]any); ok && node["id"] == args.NodeID {
				target = node
				break
			}
		}
		if target == nil {
			return "", PermissionDenied("node_not_in_canvas", "节点不属于指定画布")
		}
	} else {
		asset, err := ctx.Domain.OwnedAsset(ctx.UserID, args.AssetID)
		if err != nil {
			return "", mapDomainError(err)
		}
		if asset == nil {
			return "", NotFound("asset_not_found", "素材不存在")
		}
		if err := json.Unmarshal([]byte(asset.PayloadJSON), &target); err != nil {
			return "", PreconditionFailed("media_reference_unreadable", "素材引用无法读取", nil)
		}
	}
	ids := map[string]bool{}
	collectMediaResourceIDs(target, ids)
	if args.ResourceID != "" {
		if !ids[args.ResourceID] {
			return "", PermissionDenied("media_not_referenced", "这个资源未关联到指定素材或节点")
		}
		return args.ResourceID, nil
	}
	if len(ids) != 1 {
		return "", InvalidArg("media_resource_required", "目标必须有一个媒体资源，或指定其关联的 resourceId")
	}
	for id := range ids {
		return id, nil
	}
	return "", NotFound("media_not_found", "媒体不存在")
}

func collectMediaResourceIDs(value any, ids map[string]bool) {
	switch v := value.(type) {
	case map[string]any:
		for key, item := range v {
			if key == "resourceId" {
				if id, ok := item.(string); ok && strings.TrimSpace(id) != "" {
					ids[id] = true
				}
			}
			if key == "storageKey" || key == "content" {
				if value, ok := item.(string); ok && strings.HasPrefix(value, "resource:") {
					id := strings.TrimPrefix(value, "resource:")
					if mediaResourceIDPattern.MatchString(id) {
						ids[id] = true
					}
				}
			}
			collectMediaResourceIDs(item, ids)
		}
	case []any:
		for _, item := range v {
			collectMediaResourceIDs(item, ids)
		}
	}
}

// ReferencedMediaResourceIDs extracts canonical references from an already owned
// document. Callers still validate each resource ownership and readiness.
func ReferencedMediaResourceIDs(raw json.RawMessage) ([]string, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	collectMediaResourceIDs(value, ids)
	result := make([]string, 0, len(ids))
	for id := range ids {
		result = append(result, id)
	}
	sort.Strings(result)
	return result, nil
}

var mediaResourceIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

const maxMediaSourceBytes int64 = 256 << 20
const maxMediaPartBytes int64 = 8 << 20

type contextReader struct {
	context.Context
	io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.Context.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}

func runMedia(opCtx *Context, operation string, raw json.RawMessage) (any, error) {
	var args mediaArgs
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if args.Evidence != nil {
		if operation != "media.overview" || args.Evidence.StartMs == nil || args.Evidence.EndMs == nil || len(args.Evidence.Modes) == 0 || len(args.Evidence.Modes) > 3 {
			return nil, InvalidArg("invalid_media_evidence", "仅 overview 支持 evidence，明确提供 startMs、endMs 和1至3种模式")
		}
		if *args.Evidence.StartMs < 0 || *args.Evidence.EndMs <= *args.Evidence.StartMs || *args.Evidence.EndMs-*args.Evidence.StartMs > 15000 {
			return nil, InvalidArg("invalid_media_interval", "证据区间必须为明确的正区间，每次最多15秒")
		}
		seen := map[string]bool{}
		for _, mode := range args.Evidence.Modes {
			if (mode != "frames" && mode != "video" && mode != "audio") || seen[mode] {
				return nil, InvalidArg("invalid_media_evidence", "证据模式只能为不重复的 frames、video、audio")
			}
			seen[mode] = true
		}
	}
	resourceID, err := resolveMediaResource(opCtx, args)
	if err != nil {
		return nil, err
	}
	resource, err := opCtx.Domain.OwnedReadyResource(opCtx.UserID, resourceID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if resource == nil || resource.Size > maxMediaSourceBytes {
		return nil, PreconditionFailed("media_too_large", "当前媒体检查支持 256 MiB 以内的素材", nil)
	}
	opener, ok := opCtx.Domain.(MediaSourceOpener)
	if !ok {
		return nil, Unsupported("media_unavailable", "当前工作区不支持媒体检查")
	}
	ctx, cancel := context.WithTimeout(opCtx.Context, 90*time.Second)
	defer cancel()
	body, err := opener.OpenMediaResource(ctx, opCtx.UserID, resourceID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if body == nil {
		return nil, PreconditionFailed("media_unavailable", "媒体暂时无法读取", nil)
	}
	defer body.Close()
	readDone := make(chan struct{})
	defer close(readDone)
	go func() {
		select {
		case <-ctx.Done():
			_ = body.Close()
		case <-readDone:
		}
	}()
	dir, err := os.MkdirTemp("", "beeftv-media-*")
	if err != nil {
		return nil, PreconditionFailed("media_storage_unavailable", "媒体检查临时空间不可用", nil)
	}
	defer os.RemoveAll(dir)
	input := filepath.Join(dir, "source")
	file, err := os.OpenFile(input, os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return nil, PreconditionFailed("media_storage_unavailable", "媒体检查临时空间不可用", nil)
	}
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(contextReader{ctx, body}, maxMediaSourceBytes+1))
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		return nil, PreconditionFailed("media_read_failed", "媒体读取失败", nil)
	}
	if n > maxMediaSourceBytes {
		return nil, PreconditionFailed("media_too_large", "当前媒体检查支持 256 MiB 以内的素材", nil)
	}
	// Uploaded playlists may point at unrelated local files or network URLs.
	// Accept self-contained binary containers only before invoking any decoder.
	if !selfContainedMedia(input) {
		return nil, Unsupported("media_format_unsupported", "当前检查支持常见图片、MP4、WebM、WAV、MP3、OGG 和 FLAC 文件")
	}
	version := hex.EncodeToString(hash.Sum(nil))
	if operation != "media.overview" && args.ExpectedVersion == "" {
		return nil, InvalidArg("media_version_required", "先读取 overview，再提供 expectedVersion")
	}
	if args.ExpectedVersion != "" && args.ExpectedVersion != version {
		return nil, Conflict("stale_media_version", "素材内容已变化，请重新读取 overview", map[string]any{"currentVersion": version})
	}
	facts, err := editing.Probe(ctx, input)
	if err != nil {
		return nil, PreconditionFailed("media_probe_failed", "无法检查媒体，请确认 ffprobe 已安装且素材可读取", nil)
	}
	prepared := preparedMedia{input: input, directory: dir, source: MediaSource{CanvasID: args.CanvasID, NodeID: args.NodeID, AssetID: args.AssetID, ResourceID: resourceID, Version: version}, facts: facts, image: strings.HasPrefix(resource.MimeType, "image/")}
	if args.Evidence == nil {
		return prepared.read(ctx, operation, args)
	}
	args.StartMs, args.EndMs = *args.Evidence.StartMs, *args.Evidence.EndMs
	modes := append([]string{}, args.Evidence.Modes...)
	if args.Evidence.Checks {
		modes = append(modes, "check")
	}
	var result MediaResult
	var total int64
	for index, mode := range modes {
		args.Mode = mode
		op := "media.inspect"
		if mode == "check" {
			op = "media.check"
		}
		part, err := prepared.read(ctx, op, args)
		if err != nil {
			return nil, err
		}
		if index == 0 {
			result = part
		} else if mode == "check" {
			result.BlackIntervals, result.MeanDB, result.PeakDB = part.BlackIntervals, part.MeanDB, part.PeakDB
			result.SilenceIntervals, result.SilenceDetection, result.Note = part.SilenceIntervals, part.SilenceDetection, part.Note
		} else {
			result.Content = append(result.Content, part.Content...)
		}
		for _, content := range part.Content {
			// File parts are generated and base64 encoded locally; account for
			// the entire bundle, not each mode's independent allowance.
			total += int64(base64.StdEncoding.DecodedLen(len(content.Data)))
		}
		if total > maxMediaPartBytes {
			return nil, PreconditionFailed("media_part_too_large", "媒体证据总量过大，请缩小检查区间或减少模式", nil)
		}
	}
	result.Evidence = modes
	return result, nil
}

// Every mode reads the same owned snapshot prepared by runMedia. No mode
// resolves mutable node references, reopens source bytes, hashes or probes.
type preparedMedia struct {
	input, directory string
	source           MediaSource
	facts            editing.SourceFacts
	image            bool
}

func (p preparedMedia) read(ctx context.Context, operation string, args mediaArgs) (MediaResult, error) {
	facts, image, input, dir := p.facts, p.image, p.input, p.directory
	if operation == "media.overview" {
		args.StartMs = 0
		args.EndMs = facts.DurationMs
	}
	if operation == "media.check" && args.StartMs == 0 && args.EndMs == 0 {
		args.EndMs = facts.DurationMs
	}
	if !image && (args.StartMs < 0 || args.EndMs <= args.StartMs || args.EndMs > facts.DurationMs) {
		return MediaResult{}, InvalidArg("invalid_media_interval", "片段区间必须位于素材时长内")
	}
	if image && (args.StartMs != 0 || args.EndMs != 0 || args.Mode == "video" || args.Mode == "audio" || operation == "media.check") {
		return MediaResult{}, InvalidArg("invalid_media_interval", "图片仅支持 overview 或零区间的 frames 检查")
	}
	if operation == "media.inspect" && args.EndMs-args.StartMs > 15000 {
		return MediaResult{}, InvalidArg("media_interval_too_long", "每次查看或听取最多 15 秒")
	}
	if operation == "media.check" && args.EndMs-args.StartMs > 300000 {
		return MediaResult{}, InvalidArg("media_interval_too_long", "每次客观检测最多 5 分钟")
	}
	source := p.source
	source.StartMs, source.EndMs = args.StartMs, args.EndMs
	result := MediaResult{Source: source, DurationMs: facts.DurationMs, HasVideo: facts.HasVideo, HasAudio: facts.HasAudio, Content: []MediaPart{}}
	bin, err := editing.ResolveFFmpegBinary()
	if err != nil {
		return MediaResult{}, PreconditionFailed("media_ffmpeg_unavailable", "媒体检查需要 ffmpeg", nil)
	}
	if operation == "media.check" {
		command := []string{"-nostdin", "-hide_banner", "-ss", mediaSeconds(args.StartMs), "-i", input, "-t", mediaSeconds(args.EndMs - args.StartMs)}
		if facts.HasVideo {
			command = append(command, "-vf", "blackdetect=d=0.15:pix_th=0.1")
		}
		if facts.HasAudio {
			command = append(command, "-af", "volumedetect,silencedetect=noise=-35dB:d=0.12")
		}
		output, err := mediaCommand(ctx, bin, append(command, "-f", "null", "-")...)
		if err != nil {
			return MediaResult{}, err
		}
		result.BlackIntervals, result.MeanDB, result.PeakDB = parseMediaChecks(string(output), args.StartMs)
		if facts.HasAudio {
			result.SilenceIntervals = parseMediaSilence(string(output), args.StartMs, args.EndMs)
			result.SilenceDetection = &MediaSilenceDetection{NoiseDB: -35, MinimumDurationMs: 120, TimestampKind: "source_time"}
		}
		result.Note = "客观测量：黑屏可能是有意设计；存在音轨不代表有声音；音量不能判断声音内容。静音区间限定在本次请求内，以原素材时间表示，仅供寻找候选停顿，不是词时间戳；裁剪后用 media.inspect audio 实际听取再确认切点。"
		return result, nil
	}
	mode := args.Mode
	if mode == "" || operation == "media.overview" {
		mode = "frames"
	}
	if operation == "media.overview" && !facts.HasVideo {
		return result, nil
	}
	if mode == "frames" {
		if !facts.HasVideo {
			return MediaResult{}, InvalidArg("media_no_video", "这个素材没有画面")
		}
		count := 4
		if operation == "media.overview" {
			count = 3
		}
		if image {
			count = 1
		}
		for i := 0; i < count; i++ {
			at := args.StartMs + (args.EndMs-args.StartMs)*int64(2*i+1)/int64(2*count)
			output := filepath.Join(dir, fmt.Sprintf("frame-%d.jpg", i))
			command := []string{"-nostdin", "-v", "error", "-i", input}
			if !image {
				command = append(command, "-ss", mediaSeconds(at))
			}
			command = append(command, "-frames:v", "1", "-vf", "scale=640:640:force_original_aspect_ratio=decrease", "-y", output)
			if _, err := mediaCommand(ctx, bin, command...); err != nil {
				return MediaResult{}, err
			}
			part, err := mediaFilePart(output, "image", "image/jpeg", result.Source)
			if err != nil {
				return MediaResult{}, err
			}
			part.Source.StartMs = at
			part.Source.EndMs = at
			part.Source.TimestampKind = "requested_seek"
			result.Content = append(result.Content, part)
			var total int
			for _, item := range result.Content {
				total += base64.StdEncoding.DecodedLen(len(item.Data))
			}
			if int64(total) > maxMediaPartBytes {
				return MediaResult{}, PreconditionFailed("media_part_too_large", "媒体预览过大，请缩小检查区间", nil)
			}
		}
		return result, nil
	}
	if mode != "video" && mode != "audio" {
		return MediaResult{}, InvalidArg("invalid_media_mode", "mode 必须是 frames、video 或 audio")
	}
	if mode == "audio" && !facts.HasAudio {
		return MediaResult{}, InvalidArg("media_no_audio", "这个素材没有音轨")
	}
	if mode == "video" && !facts.HasVideo {
		return MediaResult{}, InvalidArg("media_no_video", "这个素材没有画面")
	}
	mime, output := "video/mp4", filepath.Join(dir, "clip.mp4")
	command := []string{"-nostdin", "-v", "error", "-i", input, "-ss", mediaSeconds(args.StartMs), "-t", mediaSeconds(args.EndMs - args.StartMs)}
	if mode == "audio" {
		mime, output = "audio/wav", filepath.Join(dir, "clip.wav")
		command = append(command, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le")
	} else {
		command = append(command, "-vf", "scale=640:-2", "-c:v", "libx264", "-preset", "fast", "-crf", "27", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart")
	}
	if _, err := mediaCommand(ctx, bin, append(command, "-fs", strconv.FormatInt(maxMediaPartBytes+1, 10), "-y", output)...); err != nil {
		return MediaResult{}, err
	}
	part, err := mediaFilePart(output, "media", mime, result.Source)
	if err != nil {
		return MediaResult{}, err
	}
	result.Content = append(result.Content, part)
	return result, nil
}

func mediaSeconds(ms int64) string { return fmt.Sprintf("%.3f", float64(ms)/1000) }

type limitedMediaLog struct{ data []byte }

func (b *limitedMediaLog) Write(p []byte) (int, error) {
	n := len(p)
	if len(b.data)+n > 1<<20 {
		return 0, fmt.Errorf("media output limit")
	}
	b.data = append(b.data, p...)
	return n, nil
}

func mediaCommand(ctx context.Context, bin string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	var log limitedMediaLog
	cmd.Stdout = &log
	cmd.Stderr = &log
	if err := cmd.Run(); err != nil {
		return nil, PreconditionFailed("media_processing_failed", "媒体处理失败或超时，请缩小检查区间后重试", nil)
	}
	return log.data, nil
}

func mediaFilePart(file, kind, mime string, source MediaSource) (MediaPart, error) {
	stat, err := os.Stat(file)
	if err != nil || stat.Size() == 0 {
		return MediaPart{}, PreconditionFailed("media_processing_failed", "媒体处理未产生有效内容", nil)
	}
	if stat.Size() > maxMediaPartBytes {
		return MediaPart{}, PreconditionFailed("media_part_too_large", "片段过大，请缩小检查区间", nil)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return MediaPart{}, PreconditionFailed("media_processing_failed", "媒体处理结果无法读取", nil)
	}
	hash := sha256.Sum256(data)
	return MediaPart{Type: kind, MimeType: mime, Data: base64.StdEncoding.EncodeToString(data), SHA256: hex.EncodeToString(hash[:]), Source: source}, nil
}

func selfContainedMedia(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	buf := make([]byte, 12)
	n, _ := file.Read(buf)
	buf = buf[:n]
	for _, magic := range [][]byte{{0xff, 0xd8, 0xff}, {0x89, 'P', 'N', 'G'}, []byte("GIF8"), {0x1a, 0x45, 0xdf, 0xa3}, []byte("OggS"), []byte("fLaC"), []byte("ID3")} {
		if len(buf) >= len(magic) && string(buf[:len(magic)]) == string(magic) {
			return true
		}
	}
	return (len(buf) >= 12 && ((string(buf[4:8]) == "ftyp") || (string(buf[:4]) == "RIFF" && (string(buf[8:12]) == "WAVE" || string(buf[8:12]) == "WEBP")))) || (len(buf) >= 2 && buf[0] == 0xff && buf[1]&0xe0 == 0xe0)
}

var mediaBlackPattern = regexp.MustCompile(`black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)`)
var mediaVolumePattern = regexp.MustCompile(`(mean|max)_volume: ([-\d.]+) dB`)
var mediaSilencePattern = regexp.MustCompile(`silence_(start|end):\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)`)

func parseMediaSilence(log string, startMs, endMs int64) []MediaInterval {
	intervals := []MediaInterval{}
	start := int64(-1)
	appendInterval := func(from, to int64) {
		if from < startMs {
			from = startMs
		}
		if to > endMs {
			to = endMs
		}
		if to > from {
			intervals = append(intervals, MediaInterval{from, to})
		}
	}
	for _, match := range mediaSilencePattern.FindAllStringSubmatch(log, -1) {
		seconds, err := strconv.ParseFloat(match[2], 64)
		if err != nil {
			continue
		}
		if seconds < 0 {
			seconds = 0
		}
		if maximum := float64(endMs-startMs) / 1000; seconds > maximum {
			seconds = maximum
		}
		// FFmpeg processes a seeked interval with local timestamps. Clamp any
		// decoder padding to the authorized requested source interval.
		at := startMs + int64(seconds*1000)
		if at < startMs {
			at = startMs
		}
		if match[1] == "start" {
			if start < 0 {
				start = at
			}
		} else {
			if start < 0 {
				start = startMs
			}
			appendInterval(start, at)
			start = -1
		}
	}
	// Some decoders omit the final end event; a reported silence_start has
	// already met FFmpeg's minimum duration, so close it at the request end.
	if start >= 0 {
		appendInterval(start, endMs)
	}
	return intervals
}

func parseMediaChecks(log string, startMs int64) ([]MediaInterval, *float64, *float64) {
	intervals := []MediaInterval{}
	for _, match := range mediaBlackPattern.FindAllStringSubmatch(log, -1) {
		start, _ := strconv.ParseFloat(match[1], 64)
		end, _ := strconv.ParseFloat(match[2], 64)
		intervals = append(intervals, MediaInterval{startMs + int64(start*1000), startMs + int64(end*1000)})
	}
	var mean, peak *float64
	for _, match := range mediaVolumePattern.FindAllStringSubmatch(log, -1) {
		value, err := strconv.ParseFloat(match[2], 64)
		if err == nil {
			if match[1] == "mean" {
				mean = &value
			} else {
				peak = &value
			}
		}
	}
	return intervals, mean, peak
}
