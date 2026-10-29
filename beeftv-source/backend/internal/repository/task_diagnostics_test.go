package repository

import (
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"testing"
	"time"
)

func TestTaskDiagnosticsRoundTripAndRetry(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(&model.Task{}, &model.TaskTextDelta{}); err != nil {
		t.Fatal(err)
	}
	task := &model.Task{ID: "diagnostic-task", UserID: "user", Status: model.TaskStatusRunning}
	if err = db.Create(task).Error; err != nil {
		t.Fatal(err)
	}
	r := New(db)
	d := &model.TaskFailureDiagnostics{Source: "local_validation", Summary: "最多支持 2 张参考图"}
	updated, err := r.UpdateTaskTerminalState(task.ID, "", model.TaskStatusRunning, model.TaskStatusFailed, "失败", "参数不合法", time.Now(), d)
	if err != nil || !updated {
		t.Fatalf("update: %v %v", updated, err)
	}
	loaded, err := r.Task(task.ID)
	if err != nil || loaded.FailureDiagnostics == nil || loaded.FailureDiagnostics.Summary != d.Summary {
		t.Fatalf("readback: %+v %v", loaded, err)
	}
	retried, err := r.RetryTask("user", loaded, 10)
	if err != nil || retried.FailureDiagnostics != nil {
		t.Fatalf("retry: %+v %v", retried, err)
	}
	listed, err := r.Tasks("user", 10, "", false)
	if err != nil || len(listed) != 1 || listed[0].FailureDiagnostics != nil {
		t.Fatalf("retry list: %+v %v", listed, err)
	}
	retried.Status = model.TaskStatusSucceeded
	retried.FailureDiagnostics = &model.TaskFailureDiagnostics{ExecutionResult: "completed", Requests: []model.TaskRequestEvidence{{HTTPStatus: 200, RequestID: "req-success"}}}
	if err = r.SaveTaskCompletion(retried, model.TaskStatusQueued, nil); err != nil {
		t.Fatal(err)
	}
	listed, err = r.Tasks("user", 10, "", false)
	if err != nil || len(listed) != 1 || listed[0].FailureDiagnostics == nil || listed[0].FailureDiagnostics.Requests[0].RequestID != "req-success" {
		t.Fatalf("success list: %+v %v", listed, err)
	}
}
