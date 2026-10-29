package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"net/url"
	"regexp"
	"strings"
	"time"

	_ "golang.org/x/image/webp"
)

type UpscaleOptions struct {
	Factor       int    `json:"factor"`
	OutputFormat string `json:"outputFormat,omitempty"`
}

func UpscaleMediaType(model string) string {
	switch model {
	case "topaz-standard-v2", "topaz-wonder-3.5":
		return "image"
	case "topaz-proteus", "topaz-starlight-fast-2":
		return "video"
	default:
		return ""
	}
}

func ValidateUpscaleInput(input Input) error {
	kind := UpscaleMediaType(input.Config.Model)
	if kind == "" || input.Mode != kind || input.Upscale == nil {
		return errors.New("超分模型、素材类型或参数无效")
	}
	if input.Upscale.Factor < 1 || input.Upscale.Factor > 4 {
		return errors.New("放大倍数须为 1 至 4 的整数")
	}
	if kind == "image" && (len(input.ReferenceImages) != 1 || len(input.ReferenceVideos) != 0) || kind == "video" && (len(input.ReferenceVideos) != 1 || len(input.ReferenceImages) != 0) || len(input.ReferenceAudios) != 0 || input.Mask != nil {
		return errors.New("每个超分任务需要一个同类型素材")
	}
	source := input.ReferenceImages
	if kind == "video" {
		source = input.ReferenceVideos
	}
	if !upscaleOwnedSource.MatchString(source[0].StorageKey) || source[0].URL != "" || source[0].DataURL != "" {
		return errors.New("超分只能使用当前素材库中的图片或视频")
	}
	format := input.Upscale.OutputFormat
	if format != "" && format != "png" && format != "jpeg" {
		return errors.New("图片输出格式须为 PNG 或 JPEG")
	}
	return nil
}

var upscaleOwnedSource = regexp.MustCompile(`^resource:[A-Za-z0-9_-]{1,128}$`)

// Preparation uses the existing owner-scoped media reader and gateway upload.
// Resuming an accepted task never uploads again or calls the create endpoint.
func PrepareUpscale(ctx context.Context, input Input) (Input, error) {
	input.ReferenceImages = append([]Media(nil), input.ReferenceImages...)
	input.ReferenceVideos = append([]Media(nil), input.ReferenceVideos...)
	if err := ValidateUpscaleInput(input); err != nil {
		return input, err
	}
	if !IsBeefAPIVideoConfig(ctx, input.Config) {
		return input, errors.New("AI 超分需要连接官方算力账号")
	}
	runtime, _ := RuntimeFromContext(ctx)
	if err := HydrateMedia(ctx, runtime.Call.UserID, &input, MediaHydrationPolicy{KeepLocal: true}); err != nil {
		return input, err
	}
	kind := input.Mode
	media := input.ReferenceImages
	if kind == "video" {
		media = input.ReferenceVideos
	}
	if media[0].StorageKey == "" {
		return input, errors.New("请先将素材导入素材库，再开始超分")
	}
	data, mime, skip, err := ownedSeedanceMediaReader(ctx, runtime.Call.UserID)(kind, media[0])
	if err != nil {
		return input, err
	}
	if skip {
		return input, errors.New("超分素材未通过素材库归属校验")
	}
	deliveryLimit, err := GeneratedFileLimit(ctx)
	if err != nil {
		return input, err
	}
	factor := int64(input.Upscale.Factor)
	estimatedBytes := int64(len(data))*factor*factor*2 + 1<<20
	limit := 30 << 20
	if kind == "video" {
		limit = 200 << 20
	}
	if len(data) == 0 || len(data) > limit {
		return input, errors.New("素材为空或超过超分文件大小限制")
	}
	if kind == "image" {
		if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" {
			return input, errors.New("图片仅支持 PNG、JPEG 或 WebP")
		}
		meta, err := upscaleImageConfig(data)
		if err != nil {
			return input, err
		}
		// Estimate common 8-bit PNG/JPEG output; actual bytes remain quota checked.
		estimatedBytes = int64(meta.Width)*int64(meta.Height)*factor*factor*4 + 1<<20
	} else if err := ValidateUpscaleVideoSource(ctx, data); err != nil {
		return input, err
	}
	if estimatedBytes > deliveryLimit {
		return input, fmt.Errorf("预计超分结果可能超过本机单个生成资源上限 %s，请降低放大倍数或调高资源上限后重试", formatStorageLimit(deliveryLimit))
	}
	if err := PrepareBeefAPIVideoReferences(ctx, input.Config, &input, ownedSeedanceMediaReader(ctx, runtime.Call.UserID)); err != nil {
		return input, err
	}
	return input, nil
}

func upscaleImageConfig(data []byte) (image.Config, error) {
	meta, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || meta.Width <= 0 || meta.Height <= 0 || int64(meta.Width)*int64(meta.Height) > 32<<20 {
		return meta, errors.New("图片无法读取或超过 3200 万像素")
	}
	return meta, nil
}

func upscaleBody(input Input) map[string]any {
	body := map[string]any{"model": input.Config.Model, "upscale_factor": input.Upscale.Factor}
	if input.Mode == "image" {
		body["image_url"] = input.ReferenceImages[0].URL
		body["output_format"] = defaultString(input.Upscale.OutputFormat, "png")
		body["face_enhancement"] = false
		if input.Config.Model == "topaz-wonder-3.5" {
			body["enhancement_strength"] = "low"
		}
	} else {
		body["video_url"] = input.ReferenceVideos[0].URL
		body["H264_output"] = true
	}
	return body
}

type UpscaleEstimate struct {
	Model               string  `json:"model"`
	Currency            string  `json:"currency"`
	Reservation         float64 `json:"reservation"`
	GenerationSubmitted bool    `json:"generation_submitted"`
}

func EstimateUpscale(ctx context.Context, input Input) (UpscaleEstimate, error) {
	var estimate UpscaleEstimate
	prepared, err := PrepareUpscale(ctx, input)
	if err != nil {
		return estimate, RequestPreparationError{Cause: err}
	}
	err = PostJSON(WithRequestKind(ctx, "estimate"), prepared.Config, "/media-upscale/estimate", upscaleBody(prepared), &estimate)
	if err == nil && (estimate.Model != input.Config.Model || estimate.Currency != "CNY" || estimate.Reservation <= 0 || estimate.GenerationSubmitted) {
		err = errors.New("超分预估费用无效，请重新获取")
	}
	return estimate, err
}

var upscaleTaskID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func upscaleTaskPath(id string) (string, error) {
	if !upscaleTaskID.MatchString(id) {
		return "", errors.New("超分任务 ID 无效")
	}
	return "/media-upscale/tasks/" + url.PathEscape(id), nil
}

func RunUpscaleTask(ctx context.Context, input Input) (map[string]any, error) {
	if err := ValidateUpscaleInput(input); err != nil {
		return nil, RequestPreparationError{Cause: err}
	}
	if !IsBeefAPIVideoConfig(ctx, input.Config) {
		return nil, RequestPreparationError{Cause: errors.New("AI 超分需要连接官方算力账号")}
	}
	id := ResumedProviderRequestID(ctx)
	if id == "" {
		prepared, err := PrepareUpscale(ctx, input)
		if err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
		if SubmissionKeyFromContext(ctx) == "" {
			return nil, RequestPreparationError{Cause: errors.New("超分任务缺少持久操作 ID")}
		}
		var receipt struct {
			TaskID string `json:"task_id"`
		}
		if err := postJSONWithSubmissionKey(WithRequestKind(ctx, "create"), prepared.Config, "/media-upscale/tasks", upscaleBody(prepared), &receipt, upscaleSubmissionError); err != nil {
			return nil, err
		}
		id = receipt.TaskID
		if _, err := upscaleTaskPath(id); err != nil {
			return nil, SubmissionUnknownError{Cause: err}
		}
	}
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.ReferenceProgress != nil {
		runtime.ReferenceProgress.ClearReference()
	}
	policy := DefaultVideoPollPolicy()
	policy.QueryStage = "正在确认超分结果"
	policy.InitialDelay, policy.Interval = 0, 5*time.Second
	return RunVideoPollLoop(ctx, id, policy, func(ctx context.Context) (VideoPollOutcome, error) {
		result, _, err := QueryUpscaleResult(ctx, input, id)
		return VideoPollOutcome{Done: result != nil, Result: result}, err
	})
}

// Manual recovery actively queries the saved upstream task; polling remains GET-only.
func RecoverUpscaleResult(ctx context.Context, input Input, id string) (map[string]any, string, error) {
	path, err := upscaleTaskPath(id)
	if err != nil {
		return nil, "", err
	}
	var receipt struct {
		TaskID string `json:"task_id"`
	}
	if err := PostJSON(WithRequestKind(ctx, "poll"), input.Config, path+"/recover", map[string]any{}, &receipt); err != nil {
		return nil, "", err
	}
	if receipt.TaskID != id {
		return nil, "", errors.New("超分回执与原任务不一致")
	}
	return QueryUpscaleResult(ctx, input, id)
}

func upscaleSubmissionError(err error) error {
	var unknown SubmissionUnknownError
	if errors.As(err, &unknown) {
		return err
	}
	var upstream HTTPError
	if !errors.As(err, &upstream) {
		return err
	}
	var rejection struct {
		TaskID string `json:"task_id"`
		ID     string `json:"id"`
		Error  struct {
			Code string `json:"code"`
		} `json:"error"`
		Code string `json:"code"`
	}
	if json.Unmarshal([]byte(upstream.Body), &rejection) != nil || rejection.TaskID != "" || rejection.ID != "" {
		return err
	}
	code := firstNonEmpty(rejection.Error.Code, rejection.Code)
	if (upstream.StatusCode == 400 || upstream.StatusCode == 422) && code != "" || upstream.StatusCode == 503 && (code == "fal_billing_unavailable" || code == "upscale_unavailable") {
		return SubmissionRejectedError{Cause: err}
	}
	return err
}

// Receipts cannot choose a download host or path. Only the authenticated
// content endpoint for this exact original task is used.
func QueryUpscaleStatus(ctx context.Context, config Config, id string) (string, error) {
	path, err := upscaleTaskPath(id)
	if err != nil {
		return "", err
	}
	var receipt struct {
		TaskID    string `json:"task_id"`
		Model     string `json:"model"`
		Status    string `json:"status"`
		MediaType string `json:"media_type"`
	}
	if err := GetJSON(WithRequestKind(ctx, "poll"), config, path, &receipt); err != nil {
		return "", err
	}
	if receipt.TaskID != id || receipt.Model != config.Model || receipt.MediaType != UpscaleMediaType(config.Model) {
		return "", errors.New("超分回执与原任务不一致")
	}
	return receipt.Status, nil
}

func QueryUpscaleResult(ctx context.Context, input Input, id string) (map[string]any, string, error) {
	status, err := QueryUpscaleStatus(ctx, input.Config, id)
	if err != nil {
		return nil, "", err
	}
	switch status {
	case "queued", "in_progress", "cancelling", "unknown":
		return nil, status, nil
	case "failed", "cancelled":
		return nil, status, errors.New("超分任务未完成，请查看任务详情")
	case "completed":
	default:
		return nil, status, StatePendingError{TaskID: id, Cause: fmt.Errorf("unknown upscale status")}
	}
	path, _ := upscaleTaskPath(id)
	ctx = WithRequestKind(ctx, "download")
	data, mime, err := RunVideoDownload(ctx, id, DefaultVideoPollPolicy(), func(ctx context.Context) ([]byte, string, error) {
		return GetBinary(ctx, input.Config, path+"/content")
	})
	if err != nil {
		return nil, status, VideoDownloadError{TaskID: id, Cause: err}
	}
	mime = NormalizedMediaMIMEType(mime, data)
	if input.Mode == "image" {
		if err := ValidateImageArtifact(data, mime); err != nil {
			return nil, status, VideoDownloadError{TaskID: id, Cause: err}
		}
		return map[string]any{"mode": "image", "images": []map[string]any{{"dataUrl": DataURL(mime, data), "mimeType": mime}}}, status, nil
	}
	if !strings.HasPrefix(mime, "video/") {
		return nil, status, VideoDownloadError{TaskID: id, Cause: errors.New("超分结果不是有效视频")}
	}
	if len(input.ReferenceVideos) != 1 {
		return nil, status, errors.New("缺少原视频，无法检查音轨")
	}
	runtime, _ := RuntimeFromContext(ctx)
	source, _, skip, err := ownedSeedanceMediaReader(ctx, runtime.Call.UserID)("video", Media{StorageKey: input.ReferenceVideos[0].StorageKey})
	if err != nil || skip {
		return nil, status, VideoDownloadError{TaskID: id, Cause: errors.New("原视频无法读取，暂时不能保留音轨")}
	}
	data, err = PreserveUpscaleAudio(ctx, source, data)
	if err != nil {
		return nil, status, VideoDownloadError{TaskID: id, Cause: err}
	}
	return map[string]any{"mode": "video", "video": map[string]any{"dataUrl": DataURL("video/mp4", data), "mimeType": "video/mp4"}}, status, nil
}

func CancelUpscale(ctx context.Context, config Config, id string) error {
	path, err := upscaleTaskPath(id)
	if err != nil {
		return err
	}
	var response struct {
		TaskID    string `json:"task_id"`
		Requested bool   `json:"cancellation_requested"`
	}
	if err := PostJSON(ctx, config, path+"/cancel", map[string]any{}, &response); err != nil {
		return err
	}
	if response.TaskID != id || !response.Requested {
		return errors.New("超分取消请求尚未确认")
	}
	return nil
}
