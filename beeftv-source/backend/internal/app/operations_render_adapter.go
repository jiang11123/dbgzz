package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
)

// All database collaborators use the operation-bound repository. The normal
// task domain owns execution after commit; no new worker or paid request exists.
func (s *operationSession) CreateCanvasTimelineRender(userID string, req localtask.TimelineRenderCreateRequest) (*model.Task, error) {
	policy, err := s.service.runtimePolicyWithRepo(s.repo)
	if err != nil {
		return nil, err
	}
	adapter := operationRenderDependencies{s: s, policy: policy}
	domain := localtask.NewService(localtask.NewStore(s.repo), localtask.Dependencies{
		Projects: adapter, Policy: adapter, Persist: adapter, Runtime: taskRuntimeAdapter{s.service}, Present: operationRenderPresenter{}, NewID: newID,
	})
	return domain.CreateTimelineRenderTask(userID, req)
}

type operationRenderDependencies struct {
	s      *operationSession
	policy RuntimePolicySetting
}

func (a operationRenderDependencies) ActiveTaskLimit() (int, error) {
	return a.policy.Task.ActiveTaskLimit, nil
}
func (a operationRenderDependencies) EnsureActive(userID, scopeID string) error {
	if a.s.tx == nil {
		return operations.PreconditionFailed("render_transaction_required", "本地渲染需要业务事务", nil)
	}
	return repository.RequireTaskScopeActiveTx(a.s.tx, userID, scopeID)
}
func (a operationRenderDependencies) CreateAdmitted(task *model.Task, limit int) error {
	policy := a.policy
	policy.Task.ActiveTaskLimit = limit
	return createTaskWithStorageQuotaRepository(a.s.repo, task, policy)
}

type operationRenderPresenter struct{}

func (operationRenderPresenter) Task(task model.Task) *model.Task { return &task }
func (operationRenderPresenter) Summaries(tasks []model.Task) []localtask.Summary {
	return taskSummariesForOutput(tasks)
}
func (operationRenderPresenter) Logs(logs []model.TaskLog) []model.TaskLog { return logs }

var _ operations.TimelineRenderAdmission = (*operationSession)(nil)
