package task

import (
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

// Service is the local task admission and lifecycle boundary.
// NewService is the domain constructor; it does not require every port.
// Operations fail closed when a collaborator needed on that path is missing.
type Service struct {
	store Store
	deps  Dependencies
}

func NewService(store Store, deps Dependencies) *Service {
	if deps.NewID == nil {
		deps.NewID = kernel.NewID
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	return &Service{store: store, deps: deps}
}

func (s *Service) TasksWithOptions(userID string, options ListOptions) ([]Summary, error) {
	return s.list(userID, options)
}

func (s *Service) CreateTask(userID string, request CreateRequest) (*model.Task, error) {
	return s.admit(userID, request)
}

func (s *Service) newID() string {
	if s != nil && s.deps.NewID != nil {
		return s.deps.NewID()
	}
	return kernel.NewID()
}

func (s *Service) now() time.Time {
	if s != nil && s.deps.Now != nil {
		return s.deps.Now()
	}
	return time.Now()
}

func presentTask(present Presenter, task model.Task) (*model.Task, error) {
	if present == nil {
		return nil, unavailable()
	}
	out := present.Task(task)
	if out == nil {
		return nil, unavailable()
	}
	return out, nil
}

func presentSummaries(present Presenter, tasks []model.Task) ([]Summary, error) {
	if present == nil {
		return nil, unavailable()
	}
	return present.Summaries(tasks), nil
}

func presentLogs(present Presenter, logs []model.TaskLog) ([]model.TaskLog, error) {
	if present == nil {
		return nil, unavailable()
	}
	return present.Logs(logs), nil
}

func (s *Service) log(userID, taskID, level, message, payload string) {
	if s == nil || s.deps.Logs == nil {
		return
	}
	_ = s.deps.Logs.Log(userID, taskID, level, message, payload)
}

func (s *Service) hydrateProviderRequestID(task *model.Task) {
	if task == nil || task.ProviderRequestID != "" || s == nil || s.store == nil {
		return
	}
	if providerRequestID, err := s.store.LatestProviderRequestID(task.ID); err == nil {
		task.ProviderRequestID = providerRequestID
	}
}

// ValidateRetryType is the public retryOf type/image-recovery guard used by
// canvas retry construction. Authorization is the caller's userID.
func (s *Service) ValidateRetryType(userID, taskType string, input map[string]any) error {
	return s.validateRetryType(userID, taskType, input)
}
