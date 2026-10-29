package asset

import (
	"context"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
)

func missingMediaMetadata(resource *model.Resource) bool {
	return resource != nil && ((resource.Kind == "audio" && resource.DurationMs <= 0) ||
		(resource.Kind == "video" && (resource.DurationMs <= 0 || resource.Width <= 0 || resource.Height <= 0)))
}

// EnsureMediaMetadata repairs old owned resources before a paid generation can
// use them. Persist only after a successful probe; never change task identity.
func (s *Service) EnsureMediaMetadata(ctx context.Context, userID, id string) (*model.Resource, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	unlock := s.lockWrite(userID, nil, id)
	defer unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	resource, err := s.ownedResource(userID, id)
	if err != nil {
		return nil, err
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, fmt.Errorf("参考素材尚未保存完成")
	}
	if !missingMediaMetadata(resource) {
		return resource, nil
	}
	if err := s.probeMediaMetadata(ctx, resource); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	resource.UpdatedAt = time.Now()
	if err := s.repo.UpdateResourceMediaMetadata(ctx, resource); err != nil {
		return nil, fmt.Errorf("保存媒体检查结果失败：%w", err)
	}
	return resource, nil
}

func (s *Service) probeMediaMetadata(ctx context.Context, resource *model.Resource) error {
	if !missingMediaMetadata(resource) {
		return nil
	}
	if strings.TrimSpace(resource.Provider) != "local" || s.blobs == nil {
		return fmt.Errorf("参考素材不是可读取的本地文件，请重新导入")
	}
	file, err := s.blobs.Open(resource.ObjectKey)
	if err != nil {
		return fmt.Errorf("参考素材文件无法读取，请重新导入")
	}
	defer file.Close()
	facts, err := mediatools.ProbeLocal(ctx, file.Name())
	if err != nil {
		return err
	}
	if facts.DurationMs <= 0 || (resource.Kind == "audio" && !facts.HasAudio) ||
		(resource.Kind == "video" && (!facts.HasVideo || facts.Width <= 0 || facts.Height <= 0)) {
		return fmt.Errorf("无法读取参考素材的时长或画面尺寸，请重新导入完整素材")
	}
	if resource.DurationMs <= 0 {
		resource.DurationMs = facts.DurationMs
	}
	if resource.Kind == "video" {
		if resource.Width <= 0 {
			resource.Width = facts.Width
		}
		if resource.Height <= 0 {
			resource.Height = facts.Height
		}
	}
	return nil
}
