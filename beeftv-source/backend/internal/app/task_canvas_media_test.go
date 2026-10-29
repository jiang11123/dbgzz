package app

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	localasset "infinite-canvas/backend/internal/asset"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
	"testing"
)

func TestCanvasMediaNativeCropAndRecovery(t *testing.T) {
	if _, err := mediatools.ResolveFFmpeg(); err != nil {
		t.Skip("native ffmpeg unavailable")
	}
	svc, db := newTimelineTaskTestService(t)
	svc.dataDir = t.TempDir()
	picture := image.NewRGBA(image.Rect(0, 0, 64, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 64; x++ {
			picture.Set(x, y, color.RGBA{R: 200, A: 255})
		}
	}
	var body bytes.Buffer
	if err := png.Encode(&body, picture); err != nil {
		t.Fatal(err)
	}
	source, err := svc.resourceDomain().RecoverOwned("owner", "source:0", func() (localasset.RecoveredArtifact, error) {
		return localasset.RecoveredArtifact{Kind: "image", FileName: "source.png", MimeType: "image/png", Size: int64(body.Len()), Width: 64, Height: 32, Body: bytes.NewReader(body.Bytes())}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	input := localtask.CanvasMediaInput{Node: cw.Node{ID: "crop", Role: "operation", OperationID: "image.crop", OperationVersion: 1, MediaType: "image", Config: map[string]any{"x": 0.25, "y": 0.0, "width": 0.5, "height": 1.0}}, ResourceID: source.ID}
	raw, _ := json.Marshal(input)
	task := model.Task{ID: "native-crop", UserID: "owner", Type: model.TaskTypeCanvasMediaTransform, Status: model.TaskStatusRunning, InputJSON: string(raw)}
	if err = db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	worker := svc.taskWorker()
	if err = worker.processCanvasMedia(&task, context.Background()); err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusSucceeded {
		t.Fatalf("crop failed: %s", task.Error)
	}
	id := workflowOutputResource(task.ResultJSON)
	output, err := svc.workflowResource("owner", id, "image")
	if err != nil || output.Width != 32 || output.Height != 32 {
		t.Fatalf("output %+v %v", output, err)
	}
	t.Setenv(mediatools.FFmpegPathEnv, "/missing/encoder")
	task.Status = model.TaskStatusRunning
	if err = db.Model(&model.Task{}).Where("id = ?", task.ID).Update("status", model.TaskStatusRunning).Error; err != nil {
		t.Fatal(err)
	}
	if err = worker.processCanvasMedia(&task, context.Background()); err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusSucceeded || workflowOutputResource(task.ResultJSON) != id {
		t.Fatal("recovery did not reuse original resource")
	}
}
