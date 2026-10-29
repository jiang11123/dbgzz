package app

import (
	"context"
	"io"

	"infinite-canvas/backend/internal/operations"
)

func (s *operationSession) OpenMediaResource(ctx context.Context, userID, resourceID string) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if _, err := s.OwnedReadyResource(userID, resourceID); err != nil {
		return nil, err
	}
	_, reader, err := s.service.OpenResource(userID, resourceID)
	if err != nil {
		return nil, operations.PreconditionFailed("media_read_failed", "素材暂时无法读取", nil)
	}
	return reader, err
}

var _ operations.MediaSourceOpener = (*operationSession)(nil)
