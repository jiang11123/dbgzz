package app

import (
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/depthcapture"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func TestDepthCompletionSurvivesDeliveryFailureAndSQLiteReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "depth.db")
	svc, db := newGenerationDeliveryService(t, path)
	now := time.Now()
	task := model.Task{ID: "depth-task", UserID: "owner", Type: model.TaskTypeDepthCapture, Status: model.TaskStatusRunning, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	adapter := depthTasks{w: &taskWorkerCoordinator{service: svc}}
	if err := adapter.Complete(&task, depthcapture.Result{ResourceID: "depth-resource"}); err != nil {
		t.Fatal(err)
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil || stored.Status != model.TaskStatusSucceeded {
		t.Fatalf("completion lost: %#v %v", stored, err)
	}
	closeDB(t, db)
	reopened, db := newGenerationDeliveryService(t, path)
	defer closeDB(t, db)
	if err := db.Create(&model.Resource{ID: "depth-resource", UserID: "owner", Kind: "video", MimeType: "video/mp4", Status: model.ResourceStatusReady, Size: 100, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := reopened.RecoverIncompleteGenerationDeliveries(64); err != nil {
		t.Fatal(err)
	}
	got, err := reopened.Task("owner", task.ID)
	if err != nil || got.Status != model.TaskStatusSucceeded || got.ResultState != localtask.ResultStateReady || len(got.Outputs) != 1 || got.Outputs[0].MediaType != "video" {
		t.Fatalf("depth recovery: %#v %v", got, err)
	}
}
