package bootstrap

import (
	"context"
	"infinite-canvas/backend/internal/model"
	"testing"
	"time"
)

func TestDesktopRestartPausesOnlyUnfinishedDepthCaptures(t *testing.T) {
	cfg := Config{Profile: ProfileDesktop, DataDir: t.TempDir(), ListenAddr: "127.0.0.1:0", AutoMigrate: true}
	r, err := Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range []model.Task{
		{ID: "depth-running", Type: model.TaskTypeDepthCapture, Status: model.TaskStatusRunning, Attempts: 9, InputJSON: `{"resourceId":"kept"}`},
		{ID: "depth-queued", Type: model.TaskTypeDepthCapture, Status: model.TaskStatusQueued},
		{ID: "cloud-running", Type: "canvas_video", Status: model.TaskStatusRunning, ProviderRequestID: "preserved"},
		{ID: "depth-finished", Type: model.TaskTypeDepthCapture, Status: model.TaskStatusSucceeded},
	} {
		if err := r.db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	r, err = Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close(context.Background())
	for _, id := range []string{"depth-running", "depth-queued"} {
		var task model.Task
		if err := r.db.First(&task, "id = ?", id).Error; err != nil {
			t.Fatal(err)
		}
		if task.Status != model.TaskStatusFailed || task.Stage != "已暂停，等待手动继续" {
			t.Fatalf("restarted depth=%+v", task)
		}
		if id == "depth-running" && (task.Attempts != 9 || task.InputJSON != `{"resourceId":"kept"}`) {
			t.Fatal("lost original task identity or input")
		}
	}
	var cloud model.Task
	r.db.First(&cloud, "id = ?", "cloud-running")
	if cloud.Status != model.TaskStatusRunning || cloud.ProviderRequestID != "preserved" {
		t.Fatal("restart changed cloud generation")
	}
}

func TestCompletedInitializerDoesNotBecomeTimeoutFailure(t *testing.T) {
	r, err := Open(context.Background(), Config{Profile: ProfileDesktop, DataDir: t.TempDir(), ListenAddr: "127.0.0.1:0", AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	r.backgroundDone = make(chan struct{})
	close(r.backgroundDone)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := r.Close(ctx); err != nil {
		t.Fatal(err)
	}
}
