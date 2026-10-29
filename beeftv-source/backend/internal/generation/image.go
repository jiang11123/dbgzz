package generation

// 图片生成（OpenAI / Claude / Gemini / Grok 等手写路径）。

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/providerpreset"
)

func RunImageTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	if seedreamFamily(input.Config.Model) != "" {
		return runSeedreamImageTask(ctx, input)
	}
	outputCount := 1
	if input.ImageCapability != nil && input.ImageCapability.FixedOutputs > 0 {
		outputCount = input.ImageCapability.FixedOutputs
	}
	if providerpreset.IsBeefAPIEndpoint(input.Config.BaseURL) {
		if contract, ok := providerpreset.BeefAPIImageContract(input.Config.Model); ok {
			if contract.FixedOutputs == 0 {
				return runBeefAPIImageTask(ctx, input, contract)
			}
			if input.Config.TransparentBackground == "true" || len(input.ReferenceVideos)+len(input.ReferenceAudios) > 0 {
				return nil, errors.New("当前图片模型不支持透明背景或参考音视频")
			}
			if err := modelcatalog.ValidateImageTask(nil, taskInputFromCanvas(input)); err != nil {
				return nil, err
			}
			outputCount = contract.FixedOutputs
			if len(contract.Presets) > 0 {
				prompt, err := contract.GenerationPrompt(WithSystemPrompt(input.Config, input.Prompt), input.Config.Size)
				if err != nil {
					return nil, err
				}
				input.Prompt = prompt
				input.Config.SystemPrompt = ""
				// Omit fixed square size: the gateway rejects it when --ar selects a non-square frame.
				input.Config.Size = "auto"
			}
		}
	}
	if _, ok := DeclarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType); ok {
		return RunDeclarativeProtocolTask(ctx, input)
	}
	if input.Config.InterfaceType == string(model.ChannelInterfaceGrokImage) {
		return RunGrokImageTask(ctx, input)
	}
	if input.Config.InterfaceType == string(model.ChannelInterfaceVolcengineJiMengImage) {
		return RunVolcengineJiMengImageTask(ctx, input)
	}
	if model.IsVolcengineArkImageProtocol(model.ChannelInterfaceType(input.Config.InterfaceType)) {
		return RunVolcengineArkImageTask(ctx, input)
	}
	if input.Config.InterfaceType == string(model.ChannelInterfaceGeminiImage) {
		return RunGeminiImageTask(ctx, input)
	}
	var payload ImageResponse
	if input.Mask != nil {
		// 蒙版编辑是强校验写路径：协议能力不明确时必须失败，不能静默退化为整图重绘。
		if strings.TrimSpace(input.Config.InterfaceType) != string(model.ChannelInterfaceOpenAIImage) {
			return nil, errors.New("当前渠道未声明 OpenAI Images 编辑协议，已拒绝可能忽略蒙版的整图重绘")
		}
		if len(input.ReferenceImages) == 0 {
			return nil, errors.New("蒙版编辑必须提供与蒙版同尺寸的源图片")
		}
	}
	if len(input.ReferenceImages) > 0 || input.Mask != nil {
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		writeField(writer, "model", input.Config.Model)
		writeField(writer, "prompt", WithSystemPrompt(input.Config, input.Prompt))
		writeField(writer, "n", strconv.Itoa(outputCount))
		if ImageParameterSupported(input.ImageCapability, "response_format") {
			writeField(writer, "response_format", "b64_json")
		}
		if ImageParameterSupported(input.ImageCapability, "output_format") {
			writeField(writer, "output_format", "png")
		}
		if ImageTransparentBackgroundSupported(input.ImageCapability) && input.Config.TransparentBackground == "true" {
			writeField(writer, "background", "transparent")
		}
		if ImageQualitySupported(input.ImageCapability) && input.Config.Quality != "" && !strings.EqualFold(strings.TrimSpace(input.Config.Quality), "auto") {
			writeField(writer, "quality", NormalizeImageQuality(input.Config.Quality))
		}
		if key, value := ImageSizeParameter(input.ImageCapability, input.Config.Size); value != "" {
			writeField(writer, key, value)
		}
		for _, image := range input.ReferenceImages {
			if err := writeMediaPart(writer, "image", image); err != nil {
				return nil, err
			}
		}
		if input.Mask != nil {
			if err := writeMediaPart(writer, "mask", *input.Mask); err != nil {
				return nil, err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		if err := PostForm(ctx, input.Config, "/images/edits", writer.FormDataContentType(), body, &payload); err != nil {
			return nil, err
		}
	} else {
		body := map[string]interface{}{
			"model":  input.Config.Model,
			"prompt": WithSystemPrompt(input.Config, input.Prompt),
			"n":      outputCount,
		}
		if ImageParameterSupported(input.ImageCapability, "response_format") {
			body["response_format"] = "b64_json"
		}
		if ImageParameterSupported(input.ImageCapability, "output_format") {
			body["output_format"] = "png"
		}
		if ImageTransparentBackgroundSupported(input.ImageCapability) && input.Config.TransparentBackground == "true" {
			body["background"] = "transparent"
		}
		if ImageQualitySupported(input.ImageCapability) && input.Config.Quality != "" && !strings.EqualFold(strings.TrimSpace(input.Config.Quality), "auto") {
			body["quality"] = NormalizeImageQuality(input.Config.Quality)
		}
		if key, value := ImageSizeParameter(input.ImageCapability, input.Config.Size); value != "" {
			body[key] = value
		}
		if err := PostJSON(ctx, input.Config, "/images/generations", body, &payload); err != nil {
			return nil, err
		}
	}
	images, err := ImageDataURLs(payload)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"mode": "image", "images": images}, nil
}

func RunGeminiImageTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	if input.Mask != nil {
		return nil, errors.New("Gemini Images 不支持蒙版编辑，请移除蒙版后重试")
	}
	if len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0 {
		return nil, errors.New("Gemini Images 不支持参考视频或音频")
	}

	parts := make([]GeminiImageContentPart, 0, 1+len(input.ReferenceImages))
	if prompt := strings.TrimSpace(input.Prompt); prompt != "" {
		parts = append(parts, GeminiImageContentPart{Text: prompt})
	}
	for _, image := range input.ReferenceImages {
		raw, mimeType, err := GeminiImageBytes(image)
		if err != nil {
			return nil, fmt.Errorf("读取 Gemini Images 参考图失败：%w", err)
		}
		parts = append(parts, GeminiImageContentPart{InlineData: &GeminiImageInlineData{MIMEType: mimeType, Data: base64.StdEncoding.EncodeToString(raw)}})
	}
	if len(parts) == 0 {
		return nil, errors.New("Gemini Images 请求缺少提示词或参考图")
	}

	body := GeminiImageRequest{
		Contents: []GeminiImageContent{{Role: "user", Parts: parts}},
		GenerationConfig: GeminiImageGenerationConfig{
			ResponseModalities: []string{"TEXT", "IMAGE"},
			ImageConfig:        GeminiImageConfigFor(input.Config),
		},
	}
	if systemPrompt := strings.TrimSpace(input.Config.SystemPrompt); systemPrompt != "" {
		body.SystemInstruction = &GeminiImageContent{Parts: []GeminiImageContentPart{{Text: systemPrompt}}}
	}
	var payload map[string]interface{}
	path := "/models/" + url.PathEscape(input.Config.Model) + ":generateContent"
	if err := PostGeminiJSON(ctx, input.Config, path, body, &payload); err != nil {
		return nil, err
	}
	images, err := GeminiImageDataURLs(payload)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"mode": "image", "images": images}, nil
}

func GeminiImageConfigFor(config Config) *GeminiImageConfig {
	imageConfig := &GeminiImageConfig{}
	size := strings.TrimSpace(config.Size)
	if size != "" && size != "auto" && strings.Count(size, ":") == 1 {
		imageConfig.AspectRatio = size
	}
	switch strings.ToLower(strings.TrimSpace(config.Quality)) {
	case "low", "1k":
		imageConfig.ImageSize = "1K"
	case "medium", "2k":
		imageConfig.ImageSize = "2K"
	case "high", "4k":
		imageConfig.ImageSize = "4K"
	}
	if imageConfig.AspectRatio == "" && imageConfig.ImageSize == "" {
		return nil
	}
	return imageConfig
}

func GeminiImageBytes(media Media) ([]byte, string, error) {
	raw, mimeType, err := MediaBytes(media)
	if err != nil {
		return nil, "", err
	}
	if len(raw) == 0 {
		return nil, "", errors.New("参考图片数据为空")
	}
	detected := strings.TrimSpace(strings.Split(http.DetectContentType(raw), ";")[0])
	if !strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		if !strings.HasPrefix(strings.ToLower(detected), "image/") {
			return nil, "", fmt.Errorf("参考图片 MIME 类型无效：%s", defaultString(mimeType, detected))
		}
		mimeType = detected
	} else if !strings.HasPrefix(strings.ToLower(detected), "image/") {
		// 以实际字节签名为准，避免错误的 data URL MIME 把非图片内容伪装成图片。
		return nil, "", fmt.Errorf("参考图片内容不是有效图片：%s", defaultString(detected, mimeType))
	}
	return raw, mimeType, nil
}

func GeminiImageDataURLs(payload map[string]interface{}) ([]map[string]string, error) {
	if errorValue, ok := payload["error"].(map[string]interface{}); ok {
		if message := stringField(errorValue, "message"); message != "" {
			return nil, errors.New(message)
		}
	}
	candidates, _ := payload["candidates"].([]interface{})
	images := make([]map[string]string, 0)
	for _, candidateValue := range candidates {
		candidate, _ := candidateValue.(map[string]interface{})
		content, _ := candidate["content"].(map[string]interface{})
		parts, _ := content["parts"].([]interface{})
		for _, partValue := range parts {
			part, _ := partValue.(map[string]interface{})
			inlineData, _ := part["inlineData"].(map[string]interface{})
			if inlineData == nil {
				inlineData, _ = part["inline_data"].(map[string]interface{})
			}
			if inlineData != nil {
				data := strings.TrimSpace(stringField(inlineData, "data"))
				mimeType := firstNonEmpty(stringField(inlineData, "mimeType"), stringField(inlineData, "mime_type"))
				if data == "" {
					continue
				}
				if mimeType == "" {
					mimeType = "image/png"
				}
				if !strings.HasPrefix(strings.ToLower(mimeType), "image/") {
					return nil, fmt.Errorf("Gemini Images 返回了非图片 MIME 类型：%s", mimeType)
				}
				decoded, err := base64.StdEncoding.DecodeString(data)
				if err != nil {
					return nil, fmt.Errorf("Gemini Images 返回的图片数据无效：%w", err)
				}
				images = append(images, map[string]string{"dataUrl": DataURL(mimeType, decoded)})
				continue
			}
			fileData, _ := part["fileData"].(map[string]interface{})
			if fileData != nil {
				if fileURL := firstNonEmpty(stringField(fileData, "fileUri"), stringField(fileData, "file_uri")); fileURL != "" {
					images = append(images, map[string]string{"dataUrl": fileURL})
				}
			}
		}
	}
	if len(images) == 0 {
		return nil, errors.New("Gemini Images 接口没有返回图片")
	}
	return images, nil
}

func RunGrokImageTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	body, path, err := GrokImageRequestBody(input)
	if err != nil {
		return nil, err
	}
	var payload ImageResponse
	if err := PostJSON(ctx, input.Config, path, body, &payload); err != nil {
		return nil, err
	}
	images, err := ImageDataURLs(payload)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"mode": "image", "images": images}, nil
}

func GrokImageRequestBody(input Input) (GrokImageRequest, string, error) {
	if input.Mask != nil {
		return GrokImageRequest{}, "", errors.New("Grok 图片协议不支持蒙版编辑，请移除蒙版后重试")
	}
	body := GrokImageRequest{
		Model:          input.Config.Model,
		Prompt:         WithSystemPrompt(input.Config, input.Prompt),
		N:              1,
		ResponseFormat: "url",
		// Grok 图片协议用 aspect_ratio 表达画布比例；同时发送 size 会被上游按 OpenAI 枚举校验并拒绝。
		AspectRatio: NormalizeGrokImageAspectRatio(input.Config.Size),
		Resolution:  NormalizeGrokImageResolution(input.Config.Quality),
	}
	if len(input.ReferenceImages) == 0 {
		return body, "/images/generations", nil
	}
	if len(input.ReferenceImages) != 1 {
		return GrokImageRequest{}, "", fmt.Errorf("Grok 图片编辑只支持 1 张参考图，当前连接了 %d 张", len(input.ReferenceImages))
	}
	imageURL, err := GrokImageInputURL(input.ReferenceImages[0])
	if err != nil {
		return GrokImageRequest{}, "", err
	}
	body.Image = &GrokImageInput{URL: imageURL}
	return body, "/images/edits", nil
}

// normalizeGrokImageResolution 把画布 quality（1k/2k/high…）映射为 grok2api / xAI 的 resolution。
func NormalizeGrokImageResolution(quality string) string {
	raw := strings.ToLower(strings.TrimSpace(quality))
	switch raw {
	case "", "auto":
		return ""
	case "1k", "low", "standard":
		return "1k"
	case "2k", "medium", "hd", "high", "4k":
		// xAI Imagine 图片通常最高 2k；超出则夹到 2k，避免上游拒参。
		return "2k"
	default:
		return ""
	}
}

// normalizeGrokImageAspectRatio 把画布 size（如 1280x720 / 9:16）转成 grok2api / xAI 接受的 aspect_ratio。
func NormalizeGrokImageAspectRatio(size string) string {
	raw := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(size, "×", "x")))
	if raw == "" || raw == "auto" {
		return ""
	}
	if strings.Contains(raw, ":") {
		switch raw {
		case "1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5", "19.5:9", "1:2", "2:1":
			return raw
		}
	}
	parts := strings.Split(raw, "x")
	if len(parts) != 2 {
		return ""
	}
	w, wErr := strconv.Atoi(parts[0])
	h, hErr := strconv.Atoi(parts[1])
	if wErr != nil || hErr != nil || w <= 0 || h <= 0 {
		return ""
	}
	if w == h {
		return "1:1"
	}
	ratio := float64(w) / float64(h)
	switch {
	case w*9 == h*16 || (ratio >= 1.7 && ratio <= 1.8):
		return "16:9"
	case h*9 == w*16 || (ratio > 0 && ratio <= 1.0/1.7 && ratio >= 1.0/1.8):
		return "9:16"
	case w*3 == h*4 || (ratio > 1.2 && ratio < 1.4):
		return "4:3"
	case h*3 == w*4 || (ratio > 0.7 && ratio < 0.85):
		return "3:4"
	// 像素尺寸路径必须显式覆盖 2:3 / 3:2 / 1:2 / 2:1：冒号字符串能直达（见上方 switch），
	// 但像素路径只靠 w>h 兜底会把 768x1152（2:3，ratio 0.667）错标成 9:16、
	// 1152x768（3:2，ratio 1.5）错标成 16:9，xAI 按错比例裁切生成图。
	case w*3 == h*2 || (ratio >= 0.6 && ratio < 0.72):
		return "2:3"
	case w*2 == h*3 || (ratio > 1.35 && ratio < 1.6):
		return "3:2"
	case h == w*2 || (ratio > 0.45 && ratio < 0.55):
		return "1:2"
	case w == h*2 || (ratio > 1.85 && ratio < 2.2):
		return "2:1"
	case w > h:
		return "16:9"
	default:
		return "9:16"
	}
}

func GrokImageInputURL(media Media) (string, error) {
	if IsPublicMediaURL(strings.TrimSpace(media.URL)) {
		return strings.TrimSpace(media.URL), nil
	}
	return openAIImageInputURL(media)
}

const (
	volcengineArkImageMinPixels = 3686400
	volcengineArkImageMaxPixels = 4624220
)

const (
	VolcengineArkImageMinPixels = volcengineArkImageMinPixels
	VolcengineArkImageMaxPixels = volcengineArkImageMaxPixels
)

func RunVolcengineArkImageTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	if input.Mask != nil {
		return nil, errors.New("火山方舟图片协议不支持蒙版编辑，请移除蒙版后重试")
	}
	body, err := VolcengineArkImageBody(input)
	if err != nil {
		return nil, err
	}
	var payload ImageResponse
	if err := PostJSON(ctx, input.Config, "/images/generations", body, &payload); err != nil {
		return nil, err
	}
	images, err := MaterializeImageDataURLs(ctx, input.Config, payload)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"mode": "image", "images": images}, nil
}

func MaterializeImageDataURLs(ctx context.Context, config Config, payload ImageResponse) ([]map[string]string, error) {
	images, err := ImageDataURLs(payload)
	if err != nil {
		return nil, err
	}
	for _, image := range images {
		value := strings.TrimSpace(image["dataUrl"])
		if strings.HasPrefix(value, "data:image/") {
			continue
		}
		if !IsPublicMediaURL(value) {
			return nil, errors.New("图片接口没有返回可下载的图片")
		}
		// URL results must become bytes before task persistence. Keep provider
		// authentication on same-origin content routes, never on external CDNs.
		data, mimeType, err := GetProviderExternalBinary(WithRequestKind(ctx, "download"), config, value)
		if err != nil {
			return nil, fmt.Errorf("图片结果下载失败：%w", err)
		}
		detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
		mimeType = strings.ToLower(NormalizedMediaMIMEType(mimeType, data))
		if len(data) == 0 || strings.Contains(detected, "json") || strings.HasPrefix(detected, "text/") || !strings.HasPrefix(mimeType, "image/") {
			return nil, fmt.Errorf("图片结果无效：%s", defaultString(detected, mimeType))
		}
		image["dataUrl"] = DataURL(mimeType, data)
		image["mimeType"] = mimeType
	}
	return images, nil
}

func VolcengineArkImageBody(input Input) (map[string]interface{}, error) {
	body := map[string]interface{}{
		"model":           input.Config.Model,
		"prompt":          WithSystemPrompt(input.Config, input.Prompt),
		"n":               1,
		"response_format": "b64_json",
		"watermark":       false,
	}
	if key, value := ImageSizeParameter(input.ImageCapability, input.Config.Size); value != "" {
		if key == "size" {
			value = NormalizeVolcengineArkImageSize(value)
		}
		body[key] = value
	}
	if len(input.ReferenceImages) == 0 {
		return body, nil
	}
	images := make([]string, 0, len(input.ReferenceImages))
	for _, image := range input.ReferenceImages {
		url, err := openAIImageInputURL(image)
		if err != nil {
			return nil, err
		}
		images = append(images, url)
	}
	if len(images) == 1 {
		body["image"] = images[0]
	} else {
		body["image"] = images
	}
	return body, nil
}

func NormalizeVolcengineArkImageSize(value string) string {
	size := NormalizePixelSize(value)
	parts := strings.Split(strings.ToLower(size), "x")
	if len(parts) != 2 {
		return size
	}
	width, widthErr := strconv.Atoi(parts[0])
	height, heightErr := strconv.Atoi(parts[1])
	if widthErr != nil || heightErr != nil || width <= 0 || height <= 0 {
		return size
	}
	pixels := int64(width) * int64(height)
	if pixels >= volcengineArkImageMinPixels && pixels <= volcengineArkImageMaxPixels {
		return size
	}
	targetPixels := volcengineArkImageMaxPixels
	round := math.Floor
	if pixels < volcengineArkImageMinPixels {
		targetPixels = volcengineArkImageMinPixels
		round = math.Ceil
	}
	scale := math.Sqrt(float64(targetPixels) / float64(pixels))
	width = int(round(float64(width)*scale/2)) * 2
	height = int(round(float64(height)*scale/2)) * 2
	for width > 2 && height > 2 && int64(width)*int64(height) < volcengineArkImageMinPixels {
		if width >= height {
			width += 2
		} else {
			height += 2
		}
	}
	for width > 2 && height > 2 && int64(width)*int64(height) > volcengineArkImageMaxPixels {
		if width >= height {
			width -= 2
		} else {
			height -= 2
		}
	}
	return strconv.Itoa(width) + "x" + strconv.Itoa(height)
}

func ImageDataURLs(payload ImageResponse) ([]map[string]string, error) {
	if len(payload.Data) == 0 {
		return nil, errors.New("接口没有返回图片")
	}
	images := make([]map[string]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if b64, ok := item["b64_json"].(string); ok && b64 != "" {
			images = append(images, map[string]string{"dataUrl": "data:image/png;base64," + b64})
			continue
		}
		if url, ok := item["url"].(string); ok && url != "" {
			images = append(images, map[string]string{"dataUrl": url})
		}
	}
	if len(images) == 0 {
		return nil, errors.New("接口没有返回可用图片")
	}
	return images, nil
}
