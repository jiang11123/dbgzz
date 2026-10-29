package app

import (
	"context"
	"fmt"
	"io"

	"infinite-canvas/backend/internal/editing"
)

// renderSourceOpener is the typed asset seam for native timeline render.
// Authorization stays here; editing only sees opaque source ids.
type renderSourceOpener struct {
	service *Service
	userID  string
}

func (o renderSourceOpener) Open(ctx context.Context, sourceID string) (io.ReadCloser, error) {
	_ = ctx
	if o.service == nil {
		return nil, fmt.Errorf("无法读取时间线引用的媒体，可能已被删除")
	}
	_, reader, err := o.service.OpenResource(o.userID, sourceID)
	if err != nil || reader == nil {
		return nil, fmt.Errorf("无法读取时间线引用的媒体，可能已被删除")
	}
	return reader, nil
}

func (s *Service) nativeRenderer(userID string) *editing.Renderer {
	return &editing.Renderer{Sources: renderSourceOpener{service: s, userID: userID}}
}
