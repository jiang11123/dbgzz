package asset

import (
	"mime/multipart"

	"infinite-canvas/backend/internal/model"
)

func (s *Service) UploadLocalResource(userID string, header *multipart.FileHeader, kind string, width, height int, durationMs int64, identity ...string) (*model.Resource, error) {
	resource, err := s.UploadLocal(userID, header, kind, width, height, durationMs, identity...)
	if err != nil {
		return nil, err
	}
	if resource == nil {
		return nil, ResourceMissing()
	}
	if err := s.validateListedResource(resource); err != nil {
		return nil, err
	}
	return resource, nil
}
