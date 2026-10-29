package task

import (
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestMapPersistErrorMapsTaskScope(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{repository.ErrTaskScopeNotActive, TaskScopeUnavailableMessage},
		{repository.ErrTaskScopeArchived, TaskScopeArchivedMessage},
		{repository.ErrResourceNotReadyForAdmission, ResourceNotReadyMessage},
		{repository.ErrTaskInputInvalid, TaskInputInvalidMessage},
	}
	for _, item := range cases {
		task, err := mapPersistError(item.err, CreateRequest{}, identityPresent{}, 8)
		if task != nil {
			t.Fatalf("%v mapped a task: %+v", item.err, task)
		}
		var appErr *kernel.AppError
		if !errors.As(err, &appErr) || appErr.Status != 400 || appErr.Message != item.want {
			t.Fatalf("%v mapped = %v, want 400 %q", item.err, err, item.want)
		}
		if errors.Is(err, repository.ErrTaskScopeNotActive) || errors.Is(err, repository.ErrTaskScopeArchived) {
			t.Fatalf("%v leaked repository error through kernel mapping", item.err)
		}
	}
}

func TestRetryMapsResourceAdmissionFailuresWithoutRequeue(t *testing.T) {
	for _, item := range []struct {
		err  error
		want string
	}{
		{repository.ErrResourceNotReadyForAdmission, ResourceNotReadyMessage},
		{repository.ErrTaskInputInvalid, TaskInputInvalidMessage},
	} {
		t.Run(item.want, func(t *testing.T) {
			store := newMemStore()
			store.tasks["failed"] = model.Task{ID: "failed", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed, InputJSON: `{}`}
			svc := NewService(retryErrorStore{Store: store, err: item.err}, domainService(store, nil).deps)
			_, err := svc.Retry("user", "failed")
			var appErr *kernel.AppError
			if !errors.As(err, &appErr) || appErr.Status != 400 || appErr.Message != item.want {
				t.Fatalf("retry: %v", err)
			}
			stored, _ := store.TaskForUser("user", "failed")
			if stored.Status != model.TaskStatusFailed {
				t.Fatal("invalid resource was requeued")
			}
		})
	}
}

func TestMapPersistErrorKeepsStorageFaults(t *testing.T) {
	_, storageErr := mapPersistError(errors.New("disk I/O error"), CreateRequest{}, identityPresent{}, 8)
	var appErr *kernel.AppError
	if !errors.As(storageErr, &appErr) || appErr.Reason != LocalStorageFailedReason {
		t.Fatalf("storage fault = %v", storageErr)
	}
}

func TestRetryMapsDeletedScopeAndDoesNotRequeue(t *testing.T) {
	store := newMemStore()
	failed := model.Task{
		ID: "fail-scope", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed,
		ProjectID: "canvas-deleted", Prompt: "cat", InputJSON: `{"prompt":"cat"}`,
	}
	store.tasks[failed.ID] = failed
	base := domainService(store, nil)
	svc := NewService(retryErrorStore{Store: store, err: repository.ErrTaskScopeNotActive}, base.deps)
	_, err := svc.Retry("user", failed.ID)
	if err == nil || err.Error() != TaskScopeUnavailableMessage {
		t.Fatalf("retry deleted scope error = %v", err)
	}
	stored, _ := store.TaskForUser("user", failed.ID)
	if stored.Status != model.TaskStatusFailed {
		t.Fatalf("retry mutated deleted-scope task: %+v", stored)
	}
}

func TestRetryMapsArchivedScopeAndDoesNotRequeue(t *testing.T) {
	store := newMemStore()
	failed := model.Task{
		ID: "fail-archived", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed,
		ProjectID: "project-archived", Prompt: "cat", InputJSON: `{"prompt":"cat"}`,
	}
	store.tasks[failed.ID] = failed
	base := domainService(store, nil)
	svc := NewService(retryErrorStore{Store: store, err: repository.ErrTaskScopeArchived}, base.deps)
	_, err := svc.Retry("user", failed.ID)
	if err == nil || err.Error() != TaskScopeArchivedMessage {
		t.Fatalf("retry archived scope error = %v", err)
	}
	stored, _ := store.TaskForUser("user", failed.ID)
	if stored.Status != model.TaskStatusFailed {
		t.Fatalf("retry mutated archived-scope task: %+v", stored)
	}
}

type retryErrorStore struct {
	Store
	err error
}

func (s retryErrorStore) Retry(string, *model.Task, int) (*model.Task, error) {
	return nil, s.err
}

func TestMapTaskScopeErrorIgnoresOtherErrors(t *testing.T) {
	if mapped := mapTaskScopeError(repository.ErrActiveTaskLimit); mapped != nil {
		t.Fatalf("limit mapped = %v", mapped)
	}
	if mapped := mapTaskScopeError(errors.New("disk I/O error")); mapped != nil {
		t.Fatalf("storage mapped = %v", mapped)
	}
	if !strings.Contains(TaskScopeUnavailableMessage, "画布或项目") {
		t.Fatalf("unavailable copy = %q", TaskScopeUnavailableMessage)
	}
}
