package task

import (
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"strings"
)

func (s *Service) Get(userID, id string) (*model.Task, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	if s.deps.Present == nil {
		return nil, unavailable()
	}
	task, err := s.store.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	s.hydrateProviderRequestID(task)
	return presentTask(s.deps.Present, *task)
}

// FindOperation recovers an admission receipt without reconstructing its inputs.
func (s *Service) FindOperation(userID, projectID, operationID string) (*model.Task, error) {
	projectID = strings.TrimSpace(projectID)
	key, err := ClientOperationID(map[string]any{"metadata": map[string]any{"clientOperationId": operationID}})
	if err != nil {
		return nil, err
	}
	if projectID == "" || key == "" {
		return nil, kernel.BadAuthRequest("查询生成任务需要画布和提交标识")
	}
	if s.store == nil {
		return nil, unavailable()
	}
	task, err := s.store.TaskByClientOperation(userID, key)
	if err != nil {
		return nil, err
	}
	if task == nil || task.ProjectID != projectID {
		return nil, kernel.NotFound("尚未找到这次提交的任务")
	}
	s.hydrateProviderRequestID(task)
	return presentTask(s.deps.Present, *task)
}

func (s *Service) Logs(userID, id string) ([]model.TaskLog, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	if s.deps.Present == nil {
		return nil, unavailable()
	}
	logs, err := s.store.Logs(userID, id)
	if err != nil {
		return nil, err
	}
	return presentLogs(s.deps.Present, logs)
}

func (s *Service) list(userID string, options ListOptions) ([]Summary, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	if s.deps.Present == nil {
		return nil, unavailable()
	}
	tasks, err := s.store.List(userID, options.Limit, options.ProjectID, options.ActiveOnly)
	if err != nil {
		return nil, err
	}
	return presentSummaries(s.deps.Present, tasks)
}
