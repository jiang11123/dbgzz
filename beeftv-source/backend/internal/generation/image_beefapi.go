package generation

import (
	"context"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/providerpreset"
)

func runBeefAPIImageTask(ctx context.Context, input Input, contract providerpreset.ImageContract) (map[string]interface{}, error) {
	if input.Config.TransparentBackground == "true" {
		return nil, fmt.Errorf("当前图片模型不支持透明背景")
	}
	if err := modelcatalog.ValidateImageTask(nil, taskInputFromCanvas(input)); err != nil {
		return nil, err
	}
	if len(input.ReferenceVideos)+len(input.ReferenceAudios) > 0 {
		return nil, fmt.Errorf("当前图片模型不支持参考视频或音频")
	}
	size, err := contract.PixelSize(input.Config.Size)
	if err != nil {
		return nil, err
	}
	images := make([]string, 0, len(input.ReferenceImages))
	for _, image := range input.ReferenceImages {
		if image.DataURL != "" || strings.HasPrefix(image.URL, "data:") {
			raw, mime, err := GeminiImageBytes(image)
			if err != nil {
				return nil, err
			}
			if int64(len(raw)) > contract.MaxImageBytes {
				return nil, fmt.Errorf("参考图片文件超过当前模型大小限制")
			}
			if mime != "image/png" && mime != "image/jpeg" {
				return nil, fmt.Errorf("当前图片模型仅支持 PNG 或 JPEG 参考图")
			}
			images = append(images, DataURL(mime, raw))
		} else {
			if image.URL == "" {
				return nil, fmt.Errorf("参考图片数据为空")
			}
			url, err := outbound.ValidateOutboundURL(image.URL)
			if err != nil || url.Scheme != "https" {
				return nil, fmt.Errorf("参考图片需要可访问的 HTTPS 链接")
			}
			images = append(images, image.URL)
		}
	}
	body := map[string]interface{}{"model": input.Config.Model, "prompt": WithSystemPrompt(input.Config, input.Prompt), "size": size}
	if len(images) > 0 {
		body["images"] = images
	}
	var payload ImageResponse
	if err := PostJSON(ctx, input.Config, contract.Path, body, &payload); err != nil {
		return nil, err
	}
	output, err := MaterializeImageDataURLs(ctx, input.Config, payload)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"mode": "image", "images": output}, nil
}
