package app

import (
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// CreateLocalTask is the domain-typed admission entry used by standalone HTTP
// registration. Trusted AdmissionID and PrepareOnly stay on the domain command;
// public JSON cannot set them.
func (s *Service) CreateLocalTask(userID string, request localtask.CreateRequest) (*model.Task, error) {
	return s.taskDomain().CreateTask(userID, request)
}
