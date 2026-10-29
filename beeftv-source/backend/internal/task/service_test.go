package task

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestNewServiceAdmitsWithoutFacade(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, nil)
	task, err := svc.CreateTask("user", imageReq("a cat", "proposal:gp-1:facade"))
	if err != nil {
		t.Fatal(err)
	}
	if task.ID == "" || task.Status != model.TaskStatusQueued {
		t.Fatalf("admitted = %+v", task)
	}
	listed, err := svc.TasksWithOptions("user", ListOptions{Limit: 10})
	if err != nil || len(listed) != 1 || listed[0].ID != task.ID {
		t.Fatalf("list = %#v err=%v", listed, err)
	}
}

func TestRetryOfRejectsNonStringAndPreservesStringContract(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, nil)
	parent, err := svc.CreateTask("user", imageReq("a cat", "proposal:gp-1:parent"))
	if err != nil {
		t.Fatal(err)
	}

	for _, raw := range []any{1, 1.5, true, []any{"id"}, map[string]any{"id": parent.ID}} {
		_, err := svc.CreateTask("user", CreateRequest{
			Type: "canvas_image", Prompt: "retry", ProjectID: "canvas-1",
			Input: map[string]any{"metadata": map[string]any{"retryOf": raw, "clientOperationId": "proposal:gp-1:bad-retry"}},
		})
		if err == nil || !strings.Contains(err.Error(), "retryOf 必须是字符串") {
			t.Fatalf("non-string retryOf %T (%v) error = %v", raw, raw, err)
		}
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 1 {
		t.Fatalf("non-string retryOf persisted extra tasks: %+v", listed)
	}

	created, err := svc.CreateTask("user", CreateRequest{
		Type: "canvas_image", Prompt: "retry", ProjectID: "canvas-1",
		Input: map[string]any{"metadata": map[string]any{"retryOf": parent.ID, "clientOperationId": "proposal:gp-1:string-retry"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.ID == parent.ID {
		t.Fatal("string retryOf reused the parent instead of creating a new task")
	}

	for _, raw := range []any{nil, ""} {
		task, err := svc.CreateTask("user", CreateRequest{
			Type: "canvas_image", Prompt: "plain", ProjectID: "canvas-1",
			Input: map[string]any{"metadata": map[string]any{"retryOf": raw}},
		})
		if err != nil {
			t.Fatalf("absent retryOf %v error = %v", raw, err)
		}
		if task.ID == "" {
			t.Fatal("absent retryOf did not admit")
		}
	}

	_, err = svc.CreateTask("user", CreateRequest{
		Type: "canvas_video", Prompt: "retry", ProjectID: "canvas-1",
		Input: map[string]any{"metadata": map[string]any{"retryOf": parent.ID}},
	})
	if err == nil || !strings.Contains(err.Error(), "任务类型不一致") {
		t.Fatalf("cross-type retryOf error = %v", err)
	}
}
