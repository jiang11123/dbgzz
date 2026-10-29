package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type taskTerminalRepositoryStub struct {
	task             *model.Task
	taskError        error
	terminalCalls    int
	terminalError    error
	terminalConflict bool
}

func (r *taskTerminalRepositoryStub) Task(string) (*model.Task, error) {
	if r.taskError != nil {
		return nil, r.taskError
	}
	if r.task == nil {
		return nil, errors.New("task not found")
	}
	copy := *r.task
	return &copy, nil
}

func (r *taskTerminalRepositoryStub) UpdateTaskTerminalState(_ string, _ string, _ model.TaskStatus, status model.TaskStatus, stage string, errorText string, completedAt time.Time, diagnostics ...*model.TaskFailureDiagnostics) (bool, error) {
	r.terminalCalls++
	if r.terminalConflict {
		return false, nil
	}
	if r.terminalError != nil {
		return false, r.terminalError
	}
	if r.task != nil {
		if len(diagnostics) > 0 {
			r.task.FailureDiagnostics = diagnostics[0]
		}
		r.task.Status, r.task.Stage, r.task.Error, r.task.CompletedAt = status, stage, errorText, &completedAt
	}
	return true, nil
}

type taskTerminalReplayStub struct{ statuses []model.TaskStatus }

func (r *taskTerminalReplayStub) finalizeTaskTextReplay(_ string, status model.TaskStatus) error {
	r.statuses = append(r.statuses, status)
	return nil
}

type taskTerminalLoggerStub struct{ messages []string }

func (l *taskTerminalLoggerStub) log(_ string, _ string, _ string, message string, _ string) error {
	l.messages = append(l.messages, message)
	return nil
}

type taskTerminalOutputStub struct {
	deliverCalls int
	calls        int
	order        []string
	deliverErr   error
	err          error
}

func (o *taskTerminalOutputStub) DeliverSucceededTask(model.Task) error {
	o.deliverCalls++
	o.order = append(o.order, "deliver")
	return o.deliverErr
}

func (o *taskTerminalOutputStub) RegisterTaskOutputFromTask(model.Task) error {
	o.calls++
	o.order = append(o.order, "register")
	return o.err
}

func newTaskTerminalCoordinatorForTest(repo taskTerminalRepository, replay *taskTerminalReplayStub, logger *taskTerminalLoggerStub, outputs *taskTerminalOutputStub) *taskTerminalCoordinator {
	return &taskTerminalCoordinator{repo: repo, replay: replay, logger: logger, outputs: outputs, userFacingMessage: func(err error) string { return "public: " + err.Error() }}
}

func TestTaskTerminalConflictDoesNotFinalize(t *testing.T) {
	repo := &taskTerminalRepositoryStub{terminalConflict: true}
	replay := &taskTerminalReplayStub{}
	c := newTaskTerminalCoordinatorForTest(repo, replay, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{})
	err := c.handleExecutionFailure(&model.Task{ID: "task", LeaseOwner: "stale", Status: model.TaskStatusRunning}, errors.New("upstream failed"), false, false)
	if !errors.Is(err, repository.ErrTaskStateConflict) {
		t.Fatalf("missing conflict: %v", err)
	}
	if len(replay.statuses) != 0 {
		t.Fatal("stale worker performed terminal side effects")
	}
}

func TestTaskTerminalPreservesImageAndVideoSubmissionUncertainty(t *testing.T) {
	for name, cause := range map[string]error{
		"image": imageRecoveryError{errors.New("receipt lost")},
		"video": providerSubmissionUnknownError{Cause: errors.New("receipt lost")},
	} {
		t.Run(name, func(t *testing.T) {
			task := &model.Task{ID: "task", Status: model.TaskStatusRunning}
			repo := &taskTerminalRepositoryStub{task: task}
			coordinator := newTaskTerminalCoordinatorForTest(repo, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{})
			if err := coordinator.handleExecutionFailure(task, cause, false, false); !errors.Is(err, cause) {
				t.Fatalf("original failure lost: %v", err)
			}
			if task.Stage != "submission_unknown" || !persistedFailureBlocksRetry(persistableTaskFailureMessage(cause), task.Stage) {
				t.Fatalf("ambiguous paid request became retryable: %+v", task)
			}
			if !classifyTaskFailure(cause).Uncertain {
				t.Fatal("submission uncertainty was lost")
			}
		})
	}
}

func TestTaskTerminalCoordinatorHandlesCancellation(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1"}
	repo := &taskTerminalRepositoryStub{task: task}
	replay, logger := &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}
	coordinator := newTaskTerminalCoordinatorForTest(repo, replay, logger, &taskTerminalOutputStub{})
	if err := coordinator.handleExecutionFailure(task, context.Canceled, false, false); err != nil {
		t.Fatalf("handleExecutionFailure() error = %v", err)
	}
	if task.Status != model.TaskStatusCancelled || task.Error != "任务已取消" {
		t.Fatalf("unexpected cancelled task state: status=%s error=%q", task.Status, task.Error)
	}
	if len(replay.statuses) != 1 || replay.statuses[0] != model.TaskStatusCancelled || len(logger.messages) != 1 || repo.terminalCalls != 1 {
		t.Fatalf("expected cancellation side effects, replay=%v logs=%v terminalCalls=%d", replay.statuses, logger.messages, repo.terminalCalls)
	}
}

func TestTaskTerminalCoordinatorRecordsProviderFailure(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1"}
	repo := &taskTerminalRepositoryStub{task: task}
	replay := &taskTerminalReplayStub{}
	coordinator := newTaskTerminalCoordinatorForTest(repo, replay, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{})
	failure := errors.New("provider unavailable")
	if err := coordinator.handleExecutionFailure(task, failure, false, true); !errors.Is(err, failure) {
		t.Fatalf("handleExecutionFailure() error = %v, want %v", err, failure)
	}
	if task.Status != model.TaskStatusFailed || task.Error != "public: provider unavailable" {
		t.Fatalf("unexpected failed task state: status=%s error=%q", task.Status, task.Error)
	}
	if len(replay.statuses) != 1 || replay.statuses[0] != model.TaskStatusFailed {
		t.Fatalf("unexpected replay statuses: %v", replay.statuses)
	}
}

func TestTaskTerminalCoordinatorLogsUnrecordedProviderFailure(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1"}
	coordinator := newTaskTerminalCoordinatorForTest(&taskTerminalRepositoryStub{task: task}, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{})
	var loggedTask model.Task
	var loggedErr error
	coordinator.logFailedAttempt = func(value model.Task, err error) { loggedTask, loggedErr = value, err }
	failure := errors.New("provider preflight failed")
	if err := coordinator.handleExecutionFailure(task, failure, false, true); !errors.Is(err, failure) {
		t.Fatalf("handleExecutionFailure() error = %v, want %v", err, failure)
	}
	if loggedTask.ID != task.ID || !errors.Is(loggedErr, failure) {
		t.Fatalf("logged failure = task:%#v error:%v", loggedTask, loggedErr)
	}
}

func TestTaskTerminalCoordinatorReturnsTerminalStateWriteError(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1"}
	terminalError := errors.New("database unavailable")
	coordinator := newTaskTerminalCoordinatorForTest(&taskTerminalRepositoryStub{task: task, terminalError: terminalError}, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{})
	providerError := errors.New("provider unavailable")
	if err := coordinator.handleExecutionFailure(task, providerError, false, true); !errors.Is(err, providerError) || !errors.Is(err, terminalError) {
		t.Fatalf("handleExecutionFailure() error = %v, want provider and terminal errors", err)
	}
}

func TestTaskTerminalCoordinatorReturnsOutputRegistrationErrorAfterSuccess(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1"}
	outputError := errors.New("project output unavailable")
	outputs := &taskTerminalOutputStub{err: outputError}
	coordinator := newTaskTerminalCoordinatorForTest(&taskTerminalRepositoryStub{task: task}, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, outputs)
	if err := coordinator.handleSuccess(task); !errors.Is(err, outputError) {
		t.Fatalf("handleSuccess() error = %v, want %v", err, outputError)
	}
	if outputs.deliverCalls != 2 || outputs.calls != 1 {
		t.Fatalf("expected delivery, registration, then delivery bind, deliver=%d register=%d", outputs.deliverCalls, outputs.calls)
	}
	if got := strings.Join(outputs.order, ","); got != "deliver,register,deliver" {
		t.Fatalf("output order = %s", got)
	}
}

func TestTaskTerminalCoordinatorDeliversBeforeWorkflowRegistration(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1"}
	deliverError := errors.New("delivery unavailable")
	outputs := &taskTerminalOutputStub{deliverErr: deliverError}
	coordinator := newTaskTerminalCoordinatorForTest(&taskTerminalRepositoryStub{task: task}, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, outputs)
	if err := coordinator.handleSuccess(task); !errors.Is(err, deliverError) {
		t.Fatalf("handleSuccess() error = %v, want %v", err, deliverError)
	}
	if outputs.deliverCalls != 2 || outputs.calls != 1 {
		t.Fatalf("delivery failure still registers workflow output, deliver=%d register=%d", outputs.deliverCalls, outputs.calls)
	}
	if got := strings.Join(outputs.order, ","); got != "deliver,register,deliver" {
		t.Fatalf("output order = %s", got)
	}
}

func TestTaskTerminalCoordinatorReturnsTaskReadErrorAfterSuccess(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1"}
	taskError := errors.New("task database unavailable")
	coordinator := newTaskTerminalCoordinatorForTest(&taskTerminalRepositoryStub{taskError: taskError}, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{})
	if err := coordinator.handleSuccess(task); !errors.Is(err, taskError) {
		t.Fatalf("handleSuccess() error = %v, want %v", err, taskError)
	}
}
