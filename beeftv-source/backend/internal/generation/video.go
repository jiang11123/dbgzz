package generation

// 视频生成遗留手写路径；已有官方插件的接口类型走声明式协议。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"slices"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/protocol"
	"infinite-canvas/backend/internal/providerpreset"
)

func RestoreBeefAPISeedanceAudioControl(ctx context.Context, config Config, video *VideoCapabilityConfig) {
	if config.VideoCapabilitiesVersion != nil {
		return
	}
	// Saved built-in profiles predate the supported audio switch. This is a
	// BeefAPI contract correction, not an override of custom provider settings.
	contract, known := providerpreset.BeefAPIVideoContract(config.Model)
	if IsBeefAPIVideoConfig(ctx, config) && known && contract.Protocol == "newapi" && modelcatalog.IsSeedance2Family("newapi", config.Model) {
		video.GenerateAudio.Supported = true
	}
}

func RunVideoTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	return RunVideoTaskWithPolicy(ctx, input, DefaultVideoPollPolicy())
}

func RunVideoTaskWithPolicy(ctx context.Context, input Input, pollPolicy VideoPollPolicy) (map[string]interface{}, error) {
	pollPolicy = videoPollPolicyForConfig(ctx, input.Config, pollPolicy)
	// BeefAPI exposes its flat /v1/videos contract. Route it before
	// protocol adapters so stale persisted channel metadata cannot select an
	// incompatible legacy multipart or flat request shape.
	if IsBeefAPIVideoConfig(ctx, input.Config) && (IsSeedanceVideoConfig(input.Config) || IsBeefAPIH3Model(input.Config.Model) || isBeefAPIFlatFrameVideo(input.Config.Model)) {
		return RunSeedanceVideosTask(ctx, input, pollPolicy)
	}
	// 路由顺序是协议边界，不是“哪个请求先试”：官方声明式接口必须由已注册适配器执行，
	// 缺少适配器时直接失败，不能偷偷退回遗留手写协议；只有未声明为官方插件的旧渠道才继续走兼容分支。
	if strings.TrimSpace(input.Mode) == "" {
		input.Mode = "video"
	}
	// 已有官方声明式插件的 InterfaceType 只走适配器。未注入 registry 时补官方包，
	// 显式空 registry 则报“插件未安装”，不再回退到手写协议。
	ctx = EnsureOfficialProtocolAdapter(ctx, input.Config.InterfaceType)
	if adapter, ok := DeclarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType); ok {
		return RunProtocolAdapterTaskWithPolicy(ctx, input, adapter, pollPolicy)
	}
	if label, official := OfficialDeclarativeVideoInterface(input.Config.InterfaceType); official {
		return nil, fmt.Errorf("%s 视频插件未安装", label)
	}
	if IsArkPlanVideoConfig(input.Config) {
		return RunSeedanceAgentPlanVideoTask(ctx, input, pollPolicy)
	}
	if IsSeedanceVideoConfig(input.Config) {
		return RunSeedanceVideosTask(ctx, input, pollPolicy)
	}
	if len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0 {
		return nil, errors.New("OpenAI 风格视频接口不支持参考视频或参考音频，请切换到 Seedance / Agent Plan 渠道")
	}
	id := ResumedProviderRequestID(ctx)
	var created map[string]interface{}
	if id == "" && IsGrokVideoConfig(input.Config) {
		requestBody, err := GrokVideoBody(input)
		if err != nil {
			return nil, err
		}
		if err := PostJSON(ctx, input.Config, "/videos", requestBody, &created); err != nil {
			return nil, err
		}
	} else if id == "" {
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		writeField(writer, "model", input.Config.Model)
		writeField(writer, "prompt", NewAPIVideoPromptText(input))
		writeField(writer, "seconds", defaultString(input.Config.VideoSeconds, "6"))
		if size := NormalizeVideoSize(input.Config.Size); size != "" {
			writeField(writer, "size", size)
		}
		if resolution := videoResolutionNameRequest(input.VideoCapability, input.Config.VQuality); resolution != "" {
			writeField(writer, "resolution_name", resolution)
		}
		writeField(writer, "preset", "normal")
		if ShouldSendNewAPIVideoImages(input) {
			for _, image := range input.ReferenceImages {
				if err := writeMediaPart(writer, "input_reference[]", image); err != nil {
					return nil, err
				}
			}
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		if err := PostForm(ctx, input.Config, "/videos", writer.FormDataContentType(), body, &created); err != nil {
			return nil, err
		}
	}
	if id == "" {
		extracted, err := firstJSONString(created, "id", "request_id", "task_id")
		if err != nil {
			return nil, fmt.Errorf("视频接口任务 ID 无效：%w", err)
		}
		id = extracted
	}
	if id == "" {
		if data, ok := created["data"].(map[string]interface{}); ok {
			extracted, err := firstJSONString(data, "id", "request_id", "task_id")
			if err != nil {
				return nil, fmt.Errorf("视频接口任务 ID 无效：%w", err)
			}
			id = extracted
		}
	}
	if id == "" {
		return nil, errors.New("视频接口没有返回任务 ID")
	}
	return RunVideoPollLoop(ctx, id, pollPolicy, func(ctx context.Context) (VideoPollOutcome, error) {
		var state map[string]interface{}
		if err := GetJSON(ctx, input.Config, "/videos/"+id, &state); err != nil {
			return VideoPollOutcome{}, err
		}
		var err error
		state, err = ValidateVideoTaskState(id, state)
		if err != nil {
			return VideoPollOutcome{}, err
		}
		status := strings.ToLower(stringField(state, "status"))
		if VideoTaskSucceeded(status) {
			if videoURL := NewAPIVideoResultURL(state); videoURL != "" {
				data, mimeType, err := RunVideoDownload(ctx, id, pollPolicy, videoResultDownloader(input.Config, videoURL, id, newAPIVideoURLResolver(input.Config, id)))
				if err != nil {
					return VideoPollOutcome{}, fmt.Errorf("视频结果下载失败（任务 %s）：%w", id, err)
				}
				mimeType = NormalizedMediaMIMEType(mimeType, data)
				return VideoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}}}, nil
			}
			data, mimeType, err := RunVideoDownload(ctx, id, pollPolicy, videoResultDownloader(input.Config, APIURL(input.Config.BaseURL, "/videos/"+id+"/content"), id, newAPIVideoURLResolver(input.Config, id)))
			if err != nil {
				return VideoPollOutcome{}, err
			}
			return VideoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}}}, nil
		}
		if status == "failed" || status == "cancelled" {
			return VideoPollOutcome{}, errors.New("视频生成失败")
		}
		return VideoPollOutcome{}, nil
	})
}

func NewAPIVideoResultURL(state map[string]interface{}) string {
	return NestedNewAPIVideoResultURL(state, false, 0)
}

func NestedNewAPIVideoResultURL(payload map[string]interface{}, allowResultURL bool, depth int) string {
	if depth < 2 {
		for _, key := range []string{"data", "result", "video"} {
			if nested, ok := payload[key].(map[string]interface{}); ok {
				if videoURL := NestedNewAPIVideoResultURL(nested, true, depth+1); videoURL != "" {
					return videoURL
				}
			}
		}
	}
	keys := []string{"video_url", "videoUrl", "url"}
	if allowResultURL {
		keys = append(keys, "result_url", "resultUrl")
	}
	for _, key := range keys {
		if videoURL := strings.TrimSpace(stringField(payload, key)); IsPublicMediaURL(videoURL) {
			return videoURL
		}
	}
	return ""
}

func GrokVideoBody(input Input) (map[string]interface{}, error) {
	seconds := defaultString(input.Config.VideoSeconds, "6")
	duration, err := strconv.Atoi(seconds)
	if err != nil || duration <= 0 {
		duration = 6
	}
	body := map[string]interface{}{
		"model":    input.Config.Model,
		"prompt":   strings.TrimSpace(input.Prompt),
		"duration": duration,
		"seconds":  strconv.Itoa(duration),
	}
	if size := NormalizeVideoSize(input.Config.Size); size != "" {
		body["size"] = size
	}
	if ShouldSendNewAPIVideoImages(input) && len(input.ReferenceImages) > 0 {
		images := make([]string, 0, len(input.ReferenceImages))
		for _, image := range input.ReferenceImages {
			url, err := openAIImageInputURL(image)
			if err != nil {
				return nil, err
			}
			images = append(images, url)
		}
		body["image"] = images[0]
		body["images"] = images
	}
	return body, nil
}

func RunSeedanceVideosTask(ctx context.Context, input Input, pollPolicy VideoPollPolicy) (map[string]interface{}, error) {
	pollPolicy = videoPollPolicyForConfig(ctx, input.Config, pollPolicy)
	// 恢复任务已有 provider ID 时只能继续查询，绝不能重新 create，否则会产生第二个上游任务。
	// create 成功后的 poll/download 任一失败都保留失败或结果未知语义，不降级成“成功但无内容”。
	id := ResumedProviderRequestID(ctx)
	var created map[string]interface{}
	if id == "" {
		var body interface{}
		var err error
		if IsBeefAPIVideoConfig(ctx, input.Config) {
			body, err = BeefAPIVideoRequestBody(input)
		} else {
			body, err = SeedanceVideosRequestBody(input)
		}
		if err != nil {
			return nil, err
		}
		if IsBeefAPIVideoConfig(ctx, input.Config) {
			encoded, marshalErr := json.Marshal(body)
			if marshalErr != nil {
				return nil, fmt.Errorf("序列化上游请求失败：%w", marshalErr)
			}
			if int64(len(encoded)) > VideoJSONRequestLimitBytes {
				return nil, ErrVideoJSONRequestTooLarge
			}
		}
		post := PostJSON
		if IsBeefAPIVideoConfig(ctx, input.Config) {
			post = PostJSONWithSubmissionKey
		}
		if err := post(ctx, input.Config, "/videos", body, &created); err != nil {
			return nil, UncertainVideoSubmission(ctx, err)
		}
		if data, ok := created["data"].(map[string]interface{}); ok {
			created = data
		}
		extracted, err := firstJSONString(created, "id", "task_id")
		if err != nil {
			return nil, SubmissionUnknownError{Cause: fmt.Errorf("视频接口任务 ID 无效：%w", err)}
		}
		id = extracted
	}
	if id == "" {
		return nil, SubmissionUnknownError{Cause: errors.New("视频接口没有返回任务 ID")}
	}
	return RunVideoPollLoop(ctx, id, pollPolicy, func(ctx context.Context) (VideoPollOutcome, error) {
		var state map[string]interface{}
		if err := GetJSON(ctx, input.Config, "/videos/"+id, &state); err != nil {
			return VideoPollOutcome{}, err
		}
		var err error
		state, err = ValidateVideoTaskState(id, state)
		if err != nil {
			return VideoPollOutcome{}, err
		}
		status, videoURL := SeedancePollStatusAndURL(state)
		if VideoTaskSucceeded(status) {
			if videoURL != "" {
				data, mimeType, err := RunVideoDownload(ctx, id, pollPolicy, videoResultDownloader(input.Config, videoURL, id, newAPIVideoURLResolver(input.Config, id)))
				if err != nil {
					return VideoPollOutcome{}, fmt.Errorf("视频结果下载失败：%w", err)
				}
				mimeType = NormalizedMediaMIMEType(mimeType, data)
				return VideoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}}}, nil
			}
			data, mimeType, err := RunVideoDownload(ctx, id, pollPolicy, videoResultDownloader(input.Config, APIURL(input.Config.BaseURL, "/videos/"+id+"/content"), id, newAPIVideoURLResolver(input.Config, id)))
			if err != nil {
				return VideoPollOutcome{}, fmt.Errorf("视频任务成功但未返回视频 URL，备用内容下载失败：%w", err)
			}
			mimeType = NormalizedMediaMIMEType(mimeType, data)
			return VideoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}}}, nil
		}
		if status == "failed" || status == "cancelled" || status == "expired" {
			message := SeedanceErrorMessage(state)
			if message == "" {
				payload, _ := json.Marshal(map[string]interface{}{"error": map[string]string{"code": "task_failed", "message": "视频生成失败", "task_id": id}})
				message = string(payload)
			}
			return VideoPollOutcome{}, errors.New(message)
		}
		return VideoPollOutcome{}, nil
	})
}

// BeefAPI reports the transport task as in_progress while the nested
// generation has completed and the output is being saved. Treat that nested
// terminal state as authoritative and use its URL for the content download.
func SeedancePollStatusAndURL(state map[string]interface{}) (string, string) {
	status := strings.ToLower(stringField(state, "status"))
	videoURL := stringField(state, "video_url")
	if metadata, ok := state["metadata"].(map[string]interface{}); ok {
		if generationStatus := strings.ToLower(stringField(metadata, "generation_status")); generationStatus != "" {
			status = generationStatus
		}
		if videoURL == "" {
			videoURL = stringField(metadata, "url")
		}
	}
	return status, videoURL
}

// beefAPIVideoRequestBody implements BeefAPI Enterprise's model-specific
// /v1/videos contract. Seedance reference mode uses top-level content items;
// image/reference_images are Grok fields and must not be reused for Seedance.
// 2.5 uses explicit roles even for one frame; 2.0 retains the legacy image field
// only when the single image has explicit frame intent.
func BeefAPIVideoRequestBody(input Input) (map[string]interface{}, error) {
	if IsBeefAPIH3Model(input.Config.Model) {
		return beefAPIH3VideoBody(input)
	}
	if isBeefAPIFlatFrameVideo(input.Config.Model) {
		return beefAPIFlatFrameVideoBody(input)
	}
	options := SeedanceTaskOptions(input)
	resolution := videoResolutionNameRequest(input.VideoCapability, input.Config.VQuality)
	if resolution == "" {
		resolution = NormalizeVideoResolution(input.Config.VQuality)
	}
	// A regular single reference must not become a first frame: that would
	// silently replace the selected output ratio with the image's ratio.
	singleReference := len(input.ReferenceImages) == 1 && modelcatalog.IsSeedance2Family("newapi", input.Config.Model) &&
		SeedanceTaskImageRole(input, input.ReferenceImages[0]) == "reference_image"
	referenceMode := singleReference || metadataString(input.Metadata, "videoEditOperation") == "reference_to_video" ||
		len(input.ReferenceImages) > 1 || len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0 || (modelcatalog.IsSeedance25Model(input.Config.Model) && len(input.ReferenceImages) > 0)
	if referenceMode {
		content := make([]map[string]interface{}, 0, len(input.ReferenceImages)+len(input.ReferenceVideos)+len(input.ReferenceAudios))
		for _, image := range input.ReferenceImages {
			url, err := openAIImageInputURL(image)
			if err != nil {
				return nil, err
			}
			content = append(content, map[string]interface{}{
				"type": "image_url", "image_url": map[string]interface{}{"url": url}, "role": SeedanceTaskImageRole(input, image),
			})
		}
		for _, video := range input.ReferenceVideos {
			url, err := SeedanceVideosMediaURL(video)
			if err != nil {
				return nil, err
			}
			content = append(content, map[string]interface{}{
				"type": "video_url", "video_url": map[string]interface{}{"url": url}, "role": "reference_video",
			})
		}
		for _, audio := range input.ReferenceAudios {
			url, err := BeefAPIAudioURL(audio)
			if err != nil {
				return nil, err
			}
			content = append(content, map[string]interface{}{
				"type": "audio_url", "audio_url": map[string]interface{}{"url": url}, "role": "reference_audio",
			})
		}
		metadata := map[string]interface{}{
			"ratio": options.AspectRatio,
		}
		if kind := protocol.SeedanceOmniTaskType(options); kind != "" {
			metadata["omni_reference_task_type"] = kind
		}
		if VideoCapabilitySupportsAudio(input) {
			metadata["generate_audio"] = ParseBool(input.Config.VideoGenerateAudio, true)
		}
		if VideoCapabilitySupportsWatermark(input) {
			metadata["watermark"] = ParseBool(input.Config.VideoWatermark, false)
		}
		return map[string]interface{}{
			"model": input.Config.Model, "prompt": SeedanceVideosPromptText(input),
			"seconds":    strconv.Itoa(options.Duration),
			"resolution": resolution, "content": content, "metadata": metadata,
		}, nil
	}
	body := map[string]interface{}{
		"model":      input.Config.Model,
		"prompt":     SeedanceVideosPromptText(input),
		"duration":   NormalizeSeedanceVideosDuration(input.Config.VideoSeconds),
		"resolution": resolution,
	}
	if VideoCapabilitySupportsAudio(input) {
		body["generate_audio"] = ParseBool(input.Config.VideoGenerateAudio, true)
	}
	if VideoCapabilitySupportsWatermark(input) {
		body["watermark"] = ParseBool(input.Config.VideoWatermark, false)
	}
	images := make([]map[string]interface{}, 0, len(input.ReferenceImages))
	for _, image := range input.ReferenceImages {
		url, err := openAIImageInputURL(image)
		if err != nil {
			return nil, err
		}
		images = append(images, map[string]interface{}{"url": url})
	}
	if len(images) == 1 {
		body["image"] = images[0]
	}
	// Seedance's first-frame mode derives the output ratio from the image and
	// rejects an explicit ratio as InvalidParameter.TaskTypeConstraint.
	if _, firstFrame := body["image"]; !firstFrame {
		body["aspect_ratio"] = NormalizeSeedanceVideosRatio(input.Config.Size)
	}
	return body, nil
}

func isBeefAPIFlatFrameVideo(name string) bool {
	return name == "grok-imagine-video-1.5" || name == "kling-video-v3"
}

// These gateway models take resolution and aspect_ratio separately. The Sora
// multipart adapter uses size/resolution_name and sends numeric UI resolutions.
func beefAPIFlatFrameVideoBody(input Input) (map[string]interface{}, error) {
	contract, _ := providerpreset.BeefAPIVideoContract(input.Config.Model)
	if len(input.ReferenceImages) > 1 || len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0 {
		return nil, errors.New("当前视频模型只支持一张参考图片")
	}
	seconds := defaultString(input.Config.VideoSeconds, strconv.Itoa(contract.Duration.Default))
	duration, err := strconv.Atoi(seconds)
	if err != nil || duration <= 0 {
		return nil, errors.New("视频时长必须为正整数")
	}
	maxDuration := contract.Duration.Max
	if len(input.ReferenceImages) > 0 && contract.MaxImageDuration > 0 {
		maxDuration = contract.MaxImageDuration
	}
	if duration < contract.Duration.Min || duration > maxDuration {
		return nil, fmt.Errorf("当前视频模型时长须为 %d～%d 秒", contract.Duration.Min, maxDuration)
	}
	resolution := NormalizeVideoResolution(input.Config.VQuality)
	if isAutomaticVideoResolution(input.Config.VQuality) {
		resolution = "720p"
	}
	if !slices.Contains(contract.Resolutions, resolution) {
		return nil, fmt.Errorf("当前视频模型不支持分辨率 %s", resolution)
	}
	if len(input.ReferenceImages) > 0 && contract.ReferenceResolution != "" && resolution != contract.ReferenceResolution {
		return nil, fmt.Errorf("当前视频模型带参考图片时须选择 %s 分辨率", contract.ReferenceResolution)
	}
	ratio := defaultString(input.Config.Size, "16:9")
	if (input.Config.Model != "kling-video-v3" || len(input.ReferenceImages) == 0) && !slices.Contains(contract.Ratios, ratio) {
		return nil, fmt.Errorf("当前视频模型不支持比例 %s", ratio)
	}
	body := map[string]interface{}{
		"model": input.Config.Model, "prompt": NewAPIVideoPromptText(input),
		"duration": duration, "resolution": resolution,
		"generate_audio": ParseBool(input.Config.VideoGenerateAudio, true),
	}
	if len(input.ReferenceImages) == 1 {
		url, err := openAIImageInputURL(input.ReferenceImages[0])
		if err != nil {
			return nil, err
		}
		body["image"] = map[string]interface{}{"url": url}
	}
	// Kling derives the ratio from its first frame. Grok also accepts an
	// explicit output ratio for image-to-video.
	if input.Config.Model != "kling-video-v3" || len(input.ReferenceImages) == 0 {
		body["aspect_ratio"] = ratio
	}
	return body, nil
}

func RunSeedanceAgentPlanVideoTask(ctx context.Context, input Input, pollPolicy VideoPollPolicy) (map[string]interface{}, error) {
	providerName := "Seedance"
	if model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(input.Config.InterfaceType)) {
		providerName = "火山方舟"
	}
	// Agent Plan 与 Videos API 使用相同的恢复合同：已有任务只查询，不重复创建。
	// 外部签名地址仍统一经过 doBinary 的 SSRF、状态码和响应大小检查。
	id := ResumedProviderRequestID(ctx)
	var created map[string]interface{}
	if id == "" {
		content, err := SeedanceContent(input)
		if err != nil {
			return nil, err
		}
		if model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(input.Config.InterfaceType)) && !modelcatalog.IsSeedance25Model(input.Config.Model) {
			for _, item := range content {
				if item["type"] == "image_url" {
					item["role"] = "reference_image"
				}
			}
		}
		body := SeedanceAgentPlanRequest{
			Model:      input.Config.Model,
			Content:    content,
			Ratio:      NormalizeSeedanceRatio(input.Config.Size),
			Resolution: NormalizeSeedanceResolution(input.Config.VQuality, input.Config.Model),
			Duration:   NormalizeSeedanceDuration(input.Config.VideoSeconds),
		}
		if modelcatalog.IsSeedance25Model(input.Config.Model) {
			options := SeedanceTaskOptions(input)
			body.Ratio, body.Duration = options.AspectRatio, options.Duration
			body.OmniReferenceTaskType = protocol.SeedanceOmniTaskType(options)
		}
		if VideoCapabilitySupportsAudio(input) {
			value := ParseBool(input.Config.VideoGenerateAudio, true)
			body.GenerateAudio = &value
		}
		if VideoCapabilitySupportsWatermark(input) {
			value := ParseBool(input.Config.VideoWatermark, false)
			body.Watermark = &value
		}
		if err := PostJSON(ctx, input.Config, "/contents/generations/tasks", body, &created); err != nil {
			return nil, err
		}
		if data, ok := created["data"].(map[string]interface{}); ok {
			created = data
		}
		extracted, err := firstJSONString(created, "id")
		if err != nil {
			return nil, fmt.Errorf("%s接口任务 ID 无效：%w", providerName, err)
		}
		id = extracted
	}
	if id == "" {
		return nil, fmt.Errorf("%s接口没有返回任务 ID", providerName)
	}
	return RunVideoPollLoop(ctx, id, pollPolicy, func(ctx context.Context) (VideoPollOutcome, error) {
		var state map[string]interface{}
		if err := GetJSON(ctx, input.Config, "/contents/generations/tasks/"+id, &state); err != nil {
			return VideoPollOutcome{}, err
		}
		var err error
		state, err = ValidateVideoTaskState(id, state)
		if err != nil {
			return VideoPollOutcome{}, err
		}
		status := strings.ToLower(strings.TrimSpace(stringField(state, "status")))
		if status == "succeeded" {
			content, _ := state["content"].(map[string]interface{})
			videoURL := stringField(content, "video_url")
			if videoURL == "" {
				return VideoPollOutcome{}, fmt.Errorf("%s任务成功但没有返回视频 URL", providerName)
			}
			renew := videoTaskURLResolver(input.Config, id, "/contents/generations/tasks/"+id, func(state map[string]interface{}) (string, string) {
				content, _ := state["content"].(map[string]interface{})
				return stringField(state, "status"), stringField(content, "video_url")
			})
			data, mimeType, err := RunVideoDownload(ctx, id, pollPolicy, videoResultDownloader(input.Config, videoURL, id, renew))
			if err != nil {
				return VideoPollOutcome{}, fmt.Errorf("视频结果下载失败：%w", err)
			}
			mimeType = NormalizedMediaMIMEType(mimeType, data)
			return VideoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}}}, nil
		}
		if status == "failed" || status == "cancelled" || status == "expired" {
			return VideoPollOutcome{}, fmt.Errorf("%s视频生成失败", providerName)
		}
		return VideoPollOutcome{}, nil
	})
}

func newAPIVideoURLResolver(config Config, id string) videoResultURLResolver {
	return videoTaskURLResolver(config, id, "/videos/"+id, func(state map[string]interface{}) (string, string) {
		status, rawURL := SeedancePollStatusAndURL(state)
		if rawURL == "" {
			rawURL = NewAPIVideoResultURL(state)
		}
		if rawURL == "" && VideoTaskSucceeded(status) {
			rawURL = APIURL(config.BaseURL, "/videos/"+id+"/content")
		}
		return status, rawURL
	})
}

func videoTaskURLResolver(config Config, taskID, path string, extract func(map[string]interface{}) (string, string)) videoResultURLResolver {
	return func(ctx context.Context) (string, error) {
		var state map[string]interface{}
		if err := GetJSON(WithRequestKind(ctx, "poll"), config, path, &state); err != nil {
			return "", err
		}
		var err error
		state, err = ValidateVideoTaskState(taskID, state)
		if err != nil {
			return "", err
		}
		return videoResultURL(extract(state))
	}
}

func SeedanceContent(input Input) ([]map[string]interface{}, error) {
	content := make([]map[string]interface{}, 0, 1+len(input.ReferenceImages)+len(input.ReferenceVideos)+len(input.ReferenceAudios))
	text := SeedancePromptText(input)
	if strings.TrimSpace(text) != "" {
		content = append(content, map[string]interface{}{"type": "text", "text": text})
	}
	for _, image := range input.ReferenceImages {
		url, err := MediaReferenceURL(image)
		if err != nil {
			return nil, err
		}
		role := VideoImageRole(input, image)
		if modelcatalog.IsSeedance25Model(input.Config.Model) {
			role = SeedanceTaskImageRole(input, image)
		}
		content = append(content, map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": url}, "role": role})
	}
	for _, video := range input.ReferenceVideos {
		url, err := MediaReferenceURL(video)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "video_url", "video_url": map[string]interface{}{"url": url}, "role": "reference_video"})
	}
	for _, audio := range input.ReferenceAudios {
		url, err := MediaReferenceURL(audio)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "audio_url", "audio_url": map[string]interface{}{"url": url}, "role": "reference_audio"})
	}
	if len(content) == 0 {
		return nil, errors.New("请输入视频提示词或连接参考素材")
	}
	return content, nil
}

func ShouldSendNewAPIVideoImages(input Input) bool {
	if input.Metadata == nil {
		return true
	}
	operation, _ := input.Metadata["videoEditOperation"].(string)
	return strings.TrimSpace(operation) != "text_to_video"
}

// 本地测试 helper 没有能力配置时保留历史协议字段；真实系统任务会携带已解析的模型能力。
func VideoCapabilitySupportsAudio(input Input) bool {
	return input.VideoCapability == nil || input.VideoCapability.GenerateAudio.Supported
}

func VideoCapabilitySupportsWatermark(input Input) bool {
	return input.VideoCapability == nil || input.VideoCapability.Watermark.Supported
}

func NewAPIVideoPromptText(input Input) string {
	return strings.TrimSpace(input.Prompt)
}

func SeedanceVideosRequestBody(input Input) (SeedanceVideosRequest, error) {
	if len(input.ReferenceImages) == 0 && len(input.ReferenceVideos) == 0 && len(input.ReferenceAudios) > 0 && !videoCapabilityAllowsAudioOnly(input.VideoCapability) {
		return SeedanceVideosRequest{}, errors.New("当前视频模型不支持只用音频生成视频，请同时添加参考图片或参考视频")
	}
	body := SeedanceVideosRequest{
		Model:       input.Config.Model,
		Prompt:      SeedanceVideosPromptText(input),
		AspectRatio: NormalizeSeedanceVideosRatio(input.Config.Size),
		Duration:    NormalizeSeedanceVideosDuration(input.Config.VideoSeconds),
	}
	options := SeedanceTaskOptions(input)
	if modelcatalog.IsSeedance25Model(input.Config.Model) {
		body.AspectRatio, body.Duration = options.AspectRatio, options.Duration
		body.OmniReferenceTaskType = protocol.SeedanceOmniTaskType(options)
	}
	if VideoCapabilitySupportsAudio(input) {
		value := ParseBool(input.Config.VideoGenerateAudio, true)
		body.GenerateAudio = &value
	}
	imageURLs := make([]string, 0, len(input.ReferenceImages))
	for _, image := range input.ReferenceImages {
		url, err := openAIImageInputURL(image)
		if err != nil {
			return SeedanceVideosRequest{}, err
		}
		imageURLs = append(imageURLs, url)
	}
	frameImageURLs, err := VideoFrameImageURLs(input, imageURLs)
	if err != nil {
		return SeedanceVideosRequest{}, err
	}
	if metadataString(input.Metadata, "videoEditOperation") == "reference_to_video" {
		body.ReferenceImageURLs = imageURLs
	} else if len(frameImageURLs) > 0 {
		body.ImageURLs = frameImageURLs
	} else if len(imageURLs) > 0 {
		body.ImageURL = imageURLs[0]
		if len(imageURLs) > 1 {
			body.ReferenceImageURLs = imageURLs[1:]
		}
	}
	videoURLs := make([]string, 0, len(input.ReferenceVideos))
	for _, video := range input.ReferenceVideos {
		url, err := SeedanceVideosMediaURL(video)
		if err != nil {
			return SeedanceVideosRequest{}, err
		}
		videoURLs = append(videoURLs, url)
	}
	if len(videoURLs) > 0 {
		body.ReferenceVideos = videoURLs
	}
	audioURLs := make([]string, 0, len(input.ReferenceAudios))
	for _, audio := range input.ReferenceAudios {
		url, err := SeedanceVideosMediaURL(audio)
		if err != nil {
			return SeedanceVideosRequest{}, err
		}
		audioURLs = append(audioURLs, url)
	}
	if len(audioURLs) > 0 {
		body.ReferenceAudios = audioURLs
	}
	return body, nil
}

// 兼容旧的 map 断言调用；实际请求路径使用类型化 Seedance DTO。
func SeedanceVideosBody(input Input) (map[string]interface{}, error) {
	body, err := SeedanceVideosRequestBody(input)
	if err != nil {
		return nil, err
	}
	return RequestAsMap(body)
}

func SeedancePromptText(input Input) string {
	return strings.TrimSpace(input.Prompt)
}

func SeedanceVideosPromptText(input Input) string {
	return strings.TrimSpace(input.Prompt)
}

func VideoImageRole(input Input, image Media) string {
	return VideoImageRoleOrDefault(input, image, "reference_image")
}

func SeedanceTaskImageRole(input Input, image Media) string {
	role := VideoImageRole(input, image)
	if !modelcatalog.IsSeedance25Model(input.Config.Model) {
		return role
	}
	if role == "reference_image" && metadataString(input.Metadata, "videoEditOperation") != "reference_to_video" &&
		metadataString(input.Metadata, "videoStartFrameNodeId") == "" && metadataString(input.Metadata, "videoEndFrameNodeId") == "" &&
		len(input.ReferenceVideos) == 0 && len(input.ReferenceAudios) == 0 {
		for index, candidate := range input.ReferenceImages {
			if candidate.ID == image.ID && candidate.DataURL == image.DataURL && candidate.URL == image.URL {
				if index == 0 {
					return "first_frame"
				}
				if index == 1 && len(input.ReferenceImages) == 2 {
					return "last_frame"
				}
				break
			}
		}
	}
	return role
}

func SeedanceTaskOptions(input Input) protocol.GenerationRequest {
	r := protocol.GenerationRequest{Model: input.Config.Model, AspectRatio: NormalizeSeedanceRatio(input.Config.Size), Duration: NormalizeSeedanceDuration(input.Config.VideoSeconds), Operation: metadataString(input.Metadata, "videoEditOperation")}
	for _, image := range input.ReferenceImages {
		r.Images = append(r.Images, protocol.MediaReference{Role: SeedanceTaskImageRole(input, image)})
	}
	for range input.ReferenceVideos {
		r.Videos = append(r.Videos, protocol.MediaReference{})
	}
	return protocol.NormalizeSeedanceTaskOptions(r)
}

func VideoImageRoleOrDefault(input Input, image Media, fallback string) string {
	if metadataString(input.Metadata, "videoEditOperation") == "reference_to_video" {
		return "reference_image"
	}
	if id := metadataString(input.Metadata, "videoStartFrameNodeId"); id != "" && image.ID == id {
		return "first_frame"
	}
	if id := metadataString(input.Metadata, "videoEndFrameNodeId"); id != "" && image.ID == id {
		return "last_frame"
	}
	return fallback
}

func VideoFrameImageURLs(input Input, imageURLs []string) ([]string, error) {
	if metadataString(input.Metadata, "videoEditOperation") == "reference_to_video" {
		return nil, nil
	}
	startFrameID := metadataString(input.Metadata, "videoStartFrameNodeId")
	endFrameID := metadataString(input.Metadata, "videoEndFrameNodeId")
	if startFrameID == "" && endFrameID == "" {
		return nil, nil
	}
	// image_urls 按首帧、尾帧、普通参考图排序，保持 JSON 视频协议的结构化帧语义。
	ordered := make([]string, 0, len(imageURLs))
	used := make([]bool, len(imageURLs))
	appendFrame := func(frameID string, label string) error {
		if frameID == "" {
			return nil
		}
		for index, image := range input.ReferenceImages {
			if index >= len(imageURLs) || image.ID != frameID {
				continue
			}
			ordered = append(ordered, imageURLs[index])
			used[index] = true
			return nil
		}
		return fmt.Errorf("已配置的%s参考图未包含在视频请求中", label)
	}
	if err := appendFrame(startFrameID, "首帧"); err != nil {
		return nil, err
	}
	if err := appendFrame(endFrameID, "尾帧"); err != nil {
		return nil, err
	}
	for index, imageURL := range imageURLs {
		if !used[index] {
			ordered = append(ordered, imageURL)
		}
	}
	return ordered, nil
}

func MediaReferenceURL(media Media) (string, error) {
	value := strings.TrimSpace(media.URL)
	if IsPublicMediaURL(value) || strings.HasPrefix(value, "asset://") || strings.HasPrefix(value, "data:") {
		return value, nil
	}
	value = strings.TrimSpace(media.DataURL)
	if value != "" {
		return value, nil
	}
	return "", errors.New("参考素材需要公网 URL、asset:// 素材 ID 或 data URL")
}

func SeedanceVideosMediaURL(media Media) (string, error) {
	value := strings.TrimSpace(media.DataURL)
	if strings.HasPrefix(value, "data:") {
		return value, nil
	}
	value = strings.TrimSpace(media.URL)
	if strings.HasPrefix(value, "data:") || strings.HasPrefix(value, "asset://") || IsPublicMediaURL(value) {
		return value, nil
	}
	return "", errors.New("Seedance /videos 参考素材需要公网 URL、asset:// 素材 ID 或 data URL")
}

func BeefAPIAudioURL(media Media) (string, error) {
	value := strings.TrimSpace(media.URL)
	if strings.HasPrefix(value, "asset://") || IsPublicMediaURL(value) {
		return value, nil
	}
	if strings.HasPrefix(strings.ToLower(value), "data:") {
		return value, nil
	}
	data := strings.TrimSpace(media.DataURL)
	if strings.HasPrefix(strings.ToLower(data), "data:") {
		return data, nil
	}
	return "", errors.New("参考音频需要公网 URL、asset:// 素材 ID 或 data URL")
}

func SeedanceErrorMessage(state map[string]interface{}) string {
	if errorValue, ok := state["error"].(map[string]interface{}); ok {
		message := stringField(errorValue, "message")
		code := stringField(errorValue, "code")
		if code != "" {
			// Preserve the provider code across polling and persisted task errors.
			// Flattening it into prose lets ambiguous message keywords override it.
			payload, _ := json.Marshal(map[string]interface{}{"error": map[string]string{"code": code, "message": message}})
			return string(payload)
		}
		if message != "" {
			return message
		}
	}
	code := stringField(state, "error_code")
	if code != "" {
		return code
	}
	return ""
}
