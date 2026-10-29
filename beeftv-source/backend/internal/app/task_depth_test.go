package app

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/depthcapture"
	"infinite-canvas/backend/internal/model"
)

func TestCreateDepthCaptureTaskQueuesFixedStandardProfile(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	seedResource(t, db, "res-depth-video", "usr-depth", "video/mp4")
	if err := db.Create(&model.CanvasProject{ID: "prj-depth", UserID: "usr-depth", Title: "depth"}).Error; err != nil {
		t.Fatalf("seed canvas: %v", err)
	}

	task, err := svc.CreateDepthCaptureTask("usr-depth", DepthCaptureCreateRequest{ProjectID: "prj-depth", ResourceID: "res-depth-video"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if task.Type != model.TaskTypeDepthCapture || task.Status != model.TaskStatusQueued {
		t.Fatalf("task = %s/%s, want depth_capture/queued", task.Type, task.Status)
	}
	if task.Provider != "local" || task.Model != "video-depth-anything-small" {
		t.Fatalf("provider/model = %s/%s", task.Provider, task.Model)
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatalf("load stored task: %v", err)
	}
	var input depthcapture.Input
	if err := json.Unmarshal([]byte(stored.InputJSON), &input); err != nil {
		t.Fatalf("decode input: %v", err)
	}
	if input.ResourceID != "res-depth-video" || input.Profile != depthcapture.StandardProfile {
		t.Fatalf("input = %#v", input)
	}
}

func TestCreateDepthCaptureTaskRejectsNonVideoResource(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	seedResource(t, db, "res-depth-image", "usr-depth", "image/png")

	_, err := svc.CreateDepthCaptureTask("usr-depth", DepthCaptureCreateRequest{ResourceID: "res-depth-image"})
	if err == nil || !strings.Contains(err.Error(), "视频") {
		t.Fatalf("err = %v, want video validation", err)
	}
}

func TestDepthFailurePersistsLocalDiagnosticsAndRequestIdentity(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	task := &model.Task{ID: "depth-failed", UserID: "usr-depth", Type: model.TaskTypeDepthCapture, Provider: "local", Status: model.TaskStatusRunning, RequestID: "req-depth-local"}
	if err := db.Create(task).Error; err != nil {
		t.Fatal(err)
	}
	message := strings.Repeat("\r 0 0 0 0 Time Time Current", 150) + "\ncurl: (28) Connection timed out\n模型补下载失败"
	if err := (depthTasks{w: svc.taskWorker()}).Fail(task, "深度处理失败", message); err != nil {
		t.Fatal(err)
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	d := stored.FailureDiagnostics
	if stored.Status != model.TaskStatusFailed || d == nil || d.Source != "local_result" || d.RequestID != "req-depth-local" || d.Stage != "深度处理失败" || d.ExecutionResult != "failed" || !strings.Contains(d.Summary, "curl: (28)") || !strings.HasSuffix(d.Summary, "模型补下载失败") || len([]rune(d.Summary)) > 240 {
		t.Fatalf("failed task diagnostics = %+v", d)
	}
}
