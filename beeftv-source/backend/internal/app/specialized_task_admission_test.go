package app

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/task"
)

func TestSpecializedTaskAdmissionPreservesValidationErrors(t *testing.T) {
	s, db := newTimelineTaskTestService(t)
	policy, err := s.RuntimePolicy()
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ id, project, input, message string }{
		{"missing-scope", "missing-project", `{}`, task.TaskScopeUnavailableMessage},
		{"missing-resource", "", `{"resourceId":"missing-resource"}`, task.ResourceNotReadyMessage},
		{"invalid-input", "", `{`, task.TaskInputInvalidMessage},
	} {
		t.Run(test.id, func(t *testing.T) {
			err := s.createTaskWithinStorageQuota(&model.Task{ID: test.id, UserID: "owner", ProjectID: test.project, Type: model.TaskTypeTimelineRender, Status: model.TaskStatusQueued, InputJSON: test.input}, policy)
			var appErr *kernel.AppError
			if !errors.As(err, &appErr) || appErr.Status != 400 || appErr.Message != test.message {
				t.Fatalf("validation should stay actionable, got %#v", err)
			}
			var count int64
			if err := db.Model(&model.Task{}).Where("id = ?", test.id).Count(&count).Error; err != nil || count != 0 {
				t.Fatalf("rejected task persisted: count=%d err=%v", count, err)
			}
		})
	}
}
