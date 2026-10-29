package app

import (
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

type DepthCaptureCreateRequest = localtask.DepthCaptureCreateRequest

func (s *Service) CreateDepthCaptureTask(userID string, req DepthCaptureCreateRequest) (*model.Task, error) {
	return s.taskDomain().CreateDepthCaptureTask(userID, req)
}
