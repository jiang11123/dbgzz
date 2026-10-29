package generation

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"strings"

	"infinite-canvas/backend/internal/modelcatalog"
)

const videoReferenceHeaderDecodeLimit = 2 << 20
const seedance2ReferenceMaxBytes = int64(200 << 20)

func HydrateVideoReferenceMetadata(ctx context.Context, userID string, input *Input) error {
	if input == nil {
		return nil
	}
	runtime, _ := RuntimeFromContext(ctx)
	for _, group := range [][]Media{input.ReferenceImages, input.ReferenceVideos, input.ReferenceAudios} {
		for index := range group {
			media := &group[index]
			if !strings.HasPrefix(media.StorageKey, "resource:") {
				continue
			}
			if runtime.Resources == nil {
				return errors.New("读取任务参考资源失败：资源端口未接入")
			}
			resource, err := runtime.Resources.Lookup(userID, strings.TrimPrefix(media.StorageKey, "resource:"))
			if err != nil {
				return fmt.Errorf("读取任务参考资源失败：%w", err)
			}
			if resource.Status != "ready" {
				return errors.New("任务参考资源尚未上传完成")
			}
			if (resource.Kind == "audio" && resource.DurationMs <= 0) ||
				(resource.Kind == "video" && (resource.DurationMs <= 0 || resource.Width <= 0 || resource.Height <= 0)) {
				metadata, ok := runtime.Resources.(ResourceMetadataPort)
				if !ok {
					return errors.New("参考素材缺少时长或尺寸，媒体检查服务不可用")
				}
				resource, err = metadata.EnsureMetadata(ctx, userID, resource.ID)
				if err != nil {
					return fmt.Errorf("检查参考素材失败：%w", err)
				}
			}
			if resource.DurationMs > 0 {
				media.DurationMs = resource.DurationMs
			}
			if resource.Width > 0 {
				media.Width = resource.Width
			}
			if resource.Height > 0 {
				media.Height = resource.Height
			}
			media.Bytes = resource.Size
			if (media.Width <= 0 || media.Height <= 0) && resource.LooksLikeImage(media) {
				if _, body, openErr := runtime.Resources.Open(userID, resource.ID); openErr == nil {
					width, height, decodeErr := imageHeaderDimensions(body)
					_ = body.Close()
					if decodeErr == nil {
						if media.Width <= 0 {
							media.Width = width
						}
						if media.Height <= 0 {
							media.Height = height
						}
					}
				}
			}
		}
	}
	if modelcatalog.IsSeedance2Family(input.Config.InterfaceType, input.Config.Model) && !IsBeefAPISeedancePreuploadConfig(ctx, input.Config) {
		for i := range input.ReferenceVideos {
			media := &input.ReferenceVideos[i]
			var data []byte
			var err error
			if strings.HasPrefix(media.StorageKey, "resource:") {
				if runtime.Resources == nil {
					return errors.New("读取任务参考资源失败：资源端口未接入")
				}
				_, body, openErr := runtime.Resources.Open(userID, strings.TrimPrefix(media.StorageKey, "resource:"))
				if openErr != nil {
					return fmt.Errorf("第 %d 个参考视频无法读取，请重新导入", i+1)
				}
				data, err = io.ReadAll(io.LimitReader(body, seedance2ReferenceMaxBytes+1))
				_ = body.Close()
			} else if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(raw, "data:") {
				if len(raw) > base64.StdEncoding.EncodedLen(int(seedance2ReferenceMaxBytes))+256 {
					return BadAuthRequest(fmt.Sprintf("第 %d 个参考视频文件不能超过 200MB", i+1))
				}
				_, data, err = DecodeProviderDataURL(raw)
			} else {
				continue
			}
			if err != nil || int64(len(data)) > seedance2ReferenceMaxBytes {
				return BadAuthRequest(fmt.Sprintf("第 %d 个参考视频无法读取或超过 200MB，请重新导入", i+1))
			}
			if err := applySeedance2VideoProbe(ctx, input.Config, i, media, data); err != nil {
				return err
			}
			media.Bytes = int64(len(data))
		}
	}
	return nil
}

func imageHeaderDimensions(r io.Reader) (int, int, error) {
	config, _, err := image.DecodeConfig(io.LimitReader(r, videoReferenceHeaderDecodeLimit))
	if err != nil {
		return 0, 0, err
	}
	return config.Width, config.Height, nil
}
