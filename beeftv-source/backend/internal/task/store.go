package task

import (
	"errors"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

var errStoreRequired = errors.New("task store is required")

type repoStore struct{ repo *repository.Repository }

func NewStore(repo *repository.Repository) Store {
	return repoStore{repo: repo}
}

func (s repoStore) require() error {
	if s.repo == nil {
		return kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	return nil
}

func (s repoStore) TaskForUser(userID, id string) (*model.Task, error) {
	if err := s.require(); err != nil {
		return nil, err
	}
	return s.repo.TaskForUser(userID, id)
}

func (s repoStore) TaskByClientOperation(userID, key string) (*model.Task, error) {
	if err := s.require(); err != nil {
		return nil, err
	}
	return s.repo.TaskByClientOperation(userID, key)
}

func (s repoStore) ActiveTaskCount(userID string) (int64, error) {
	if err := s.require(); err != nil {
		return 0, err
	}
	return s.repo.ActiveTaskCountForUser(userID)
}

func (s repoStore) CreateWithLimit(task *model.Task, limit int) error {
	if err := s.require(); err != nil {
		return err
	}
	return s.repo.CreateTaskWithActiveLimit(task, limit)
}

func (s repoStore) Retry(userID string, prepared *model.Task, limit int) (*model.Task, error) {
	if err := s.require(); err != nil {
		return nil, err
	}
	return s.repo.RetryTask(userID, prepared, limit)
}

func (s repoStore) RetryWithExpectedInput(userID string, prepared *model.Task, limit int, expectedInputJSON string) (*model.Task, error) {
	if err := s.require(); err != nil {
		return nil, err
	}
	return s.repo.RetryTaskWithExpectedInput(userID, prepared, limit, expectedInputJSON)
}

func (s repoStore) CancelIfStatus(userID, id string, expected model.TaskStatus, now time.Time) (bool, error) {
	if err := s.require(); err != nil {
		return false, err
	}
	return s.repo.CancelTaskIfStatus(userID, id, expected, now)
}

func (s repoStore) List(userID string, limit int, projectID string, activeOnly bool) ([]model.Task, error) {
	if err := s.require(); err != nil {
		return nil, err
	}
	return s.repo.Tasks(userID, limit, projectID, activeOnly)
}

func (s repoStore) Logs(userID, id string) ([]model.TaskLog, error) {
	if err := s.require(); err != nil {
		return nil, err
	}
	return s.repo.TaskLogs(userID, id)
}

func (s repoStore) LatestProviderRequestID(taskID string) (string, error) {
	if err := s.require(); err != nil {
		return "", err
	}
	return s.repo.LatestProviderRequestIDForTask(taskID)
}
