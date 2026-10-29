package app

import (
	"context"
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/taskruntime"
)

func TestTerminalWriteAppliedFollowsDurableSuccess(t *testing.T) {
	cause := errors.New("upstream failed")
	if !terminalWriteApplied(nil, cause) {
		t.Fatal("nil terminal error is durable")
	}
	if !terminalWriteApplied(cause, cause) {
		t.Fatal("original cause after successful terminal write is durable")
	}
	if terminalWriteApplied(errors.Join(cause, errors.New("写入任务终态失败")), cause) {
		t.Fatal("joined terminal write failure is not durable")
	}
	if terminalWriteApplied(repository.ErrTaskStateConflict, cause) {
		t.Fatal("conflict without a successful write is not durable")
	}
}

func TestExecutionFailureOutcomeAppliedFollowsTerminalWrite(t *testing.T) {
	cause := errors.New("provider unavailable")
	t.Run("write ok", func(t *testing.T) {
		task := &model.Task{ID: "task-ok", UserID: "user", Status: model.TaskStatusRunning, LeaseOwner: "owner"}
		repo := &taskTerminalRepositoryStub{task: task}
		outcome := executionFailureOutcome(newTaskTerminalCoordinatorForTest(repo, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{}), task, cause, false, false, false)
		if !outcome.Applied || outcome.Kind != taskruntime.KindFailed || !errors.Is(outcome.Err, cause) {
			t.Fatalf("outcome=%+v", outcome)
		}
	})
	t.Run("write failed", func(t *testing.T) {
		task := &model.Task{ID: "task-fail", UserID: "user", Status: model.TaskStatusRunning, LeaseOwner: "owner"}
		repo := &taskTerminalRepositoryStub{task: task, terminalError: errors.New("db down")}
		outcome := executionFailureOutcome(newTaskTerminalCoordinatorForTest(repo, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{}), task, cause, false, false, false)
		if outcome.Applied {
			t.Fatalf("Applied=true after terminal write failed: %+v", outcome)
		}
		if outcome.Kind != taskruntime.KindFailed {
			t.Fatalf("kind=%s", outcome.Kind)
		}
	})
	t.Run("cancel write ok", func(t *testing.T) {
		task := &model.Task{ID: "task-cancel", UserID: "user", Status: model.TaskStatusRunning, LeaseOwner: "owner"}
		repo := &taskTerminalRepositoryStub{task: task}
		outcome := executionFailureOutcome(newTaskTerminalCoordinatorForTest(repo, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{}), task, context.Canceled, false, false, false)
		if !outcome.Applied || outcome.Kind != taskruntime.KindCancelled {
			t.Fatalf("outcome=%+v", outcome)
		}
	})
}

func TestPersistenceFailureOutcomeAppliedFollowsTerminalWrite(t *testing.T) {
	cause := errors.New("disk full")
	task := &model.Task{ID: "task-persist", UserID: "user", Status: model.TaskStatusRunning, LeaseOwner: "owner"}
	ok := persistenceFailureOutcome(newTaskTerminalCoordinatorForTest(&taskTerminalRepositoryStub{task: task}, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{}), task, cause, true)
	if !ok.Applied || ok.Kind != taskruntime.KindFailed {
		t.Fatalf("ok=%+v", ok)
	}
	failedTask := &model.Task{ID: "task-persist-fail", UserID: "user", Status: model.TaskStatusRunning, LeaseOwner: "owner"}
	failed := persistenceFailureOutcome(newTaskTerminalCoordinatorForTest(&taskTerminalRepositoryStub{task: failedTask, terminalError: errors.New("db down")}, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{}), failedTask, cause, true)
	if failed.Applied {
		t.Fatalf("Applied=true after persistence terminal write failed: %+v", failed)
	}
}

func TestPreparationFailureOutcomeAppliedFollowsTerminalWrite(t *testing.T) {
	cause := routeDispatchUncertainError{"上一次提交结果不明确，为避免重复创建上游任务已停止自动重发"}
	task := &model.Task{ID: "prep-ok", UserID: "user", Status: model.TaskStatusRunning, LeaseOwner: "owner"}
	terminal := newTaskTerminalCoordinatorForTest(&taskTerminalRepositoryStub{task: task}, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{})
	termErr := terminal.markPreparationFailure(task, "路由准备失败", cause, true, "路由准备失败，上游请求未发出")
	if !terminalWriteApplied(termErr, cause) {
		t.Fatal("successful preparation failure write should be Applied")
	}
	failedTask := &model.Task{ID: "prep-fail", UserID: "user", Status: model.TaskStatusRunning, LeaseOwner: "owner"}
	failedTerminal := newTaskTerminalCoordinatorForTest(&taskTerminalRepositoryStub{task: failedTask, terminalError: errors.New("db down")}, &taskTerminalReplayStub{}, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{})
	failedErr := failedTerminal.markPreparationFailure(failedTask, "路由准备失败", cause, true, "路由准备失败，上游请求未发出")
	if terminalWriteApplied(failedErr, cause) {
		t.Fatal("failed preparation write should not be Applied")
	}
}
