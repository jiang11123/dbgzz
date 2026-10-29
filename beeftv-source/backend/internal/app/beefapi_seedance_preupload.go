package app

import (
	"context"
	"fmt"
	"io"
	"strings"
)

func (s *Service) prepareBeefAPISeedanceReferences(ctx context.Context, userID string, input *canvasGenerationInput) error {
	if input == nil || input.Mode != "video" || !isBeefAPISeedancePreuploadConfig(ctx, input.Config) {
		return nil
	}
	return prepareBeefAPISeedanceReferences(ctx, input.Config, input, func(kind string, media providerMedia) ([]byte, string, bool, error) {
		return s.readBeefAPISeedanceMedia(userID, kind, media)
	})
}

func (s *Service) readBeefAPISeedanceMedia(userID string, kind string, media providerMedia) ([]byte, string, bool, error) {
	if skipBeefAPISeedanceMedia(media) {
		return nil, "", true, nil
	}
	if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(strings.TrimSpace(raw), "data:") {
		mimeType, data, err := decodeProviderDataURL(raw)
		if err != nil {
			return nil, "", false, err
		}
		return data, firstNonEmpty(media.MimeType, mimeType), false, nil
	}
	if !strings.HasPrefix(media.StorageKey, "resource:") {
		return nil, "", true, nil
	}
	if media.Bytes > 0 {
		if err := validateBeefAPISeedanceMediaSize(kind, media.Bytes); err != nil {
			return nil, "", false, err
		}
	}
	resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
	resource, body, err := s.OpenResource(userID, resourceID)
	if err != nil {
		return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
	}
	defer body.Close()
	max := beefAPISeedanceKindMaxBytes(kind)
	data, err := io.ReadAll(io.LimitReader(body, max+1))
	if err != nil {
		return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
	}
	return data, firstNonEmpty(media.MimeType, resource.MimeType), false, nil
}
