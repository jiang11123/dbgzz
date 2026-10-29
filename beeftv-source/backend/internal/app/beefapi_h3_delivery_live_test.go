package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// This consumes already-generated canary files. It never submits inference or
// requires a provider credential, and is skipped in ordinary test runs.
func TestBeefAPIH3RealMediaDeliverySurvivesRestart(t *testing.T) {
	dir := os.Getenv("FAL_H3_REAL_MEDIA_DIR")
	if dir == "" {
		t.Skip("explicit existing real-media fixture opt-in required")
	}
	names := []string{"text-768p", "first-last-480p", "last-only-1080p", "pinned-audio-768p"}
	if explicit := os.Getenv("FAL_H3_REAL_MEDIA_CASES"); explicit != "" {
		names = strings.Split(explicit, ",")
	}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			if strings.ContainsAny(name, "/\\") || name == "" {
				t.Fatal("invalid real media case")
			}
			original, err := os.ReadFile(filepath.Join(dir, name+".mp4"))
			if err != nil {
				t.Fatal(err)
			}
			dataDir := t.TempDir()
			svc, db := openDBRuntimeMatrix(t, dataDir)
			now := time.Now()
			modelName := "minimax-h3-max-turbo"
			for _, style := range []string{"hand-drawn", "16bit-pixel", "low-poly", "retro-toon-70s", "vhs"} {
				if name == style {
					modelName = "minimax-h3-max-style-" + style
				}
			}
			inputJSON, _ := json.Marshal(map[string]any{"metadata": map[string]any{"source": "canvas", "nodeId": "h3-output"}, "config": map[string]any{"model": modelName}})
			task := model.Task{ID: "h3-real-" + name, UserID: "local", ProjectID: "canvas-h3", Type: "canvas_video", Status: model.TaskStatusSucceeded,
				InputJSON: string(inputJSON), CreatedAt: now, UpdatedAt: now, CompletedAt: &now}
			canvas, err := json.Marshal(map[string]any{"id": task.ProjectID, "title": "H3 real-media canary", "revision": 0, "connections": []any{}, "nodes": []any{map[string]any{"id": "h3-output", "type": "video", "position": map[string]any{"x": 0, "y": 0}, "metadata": map[string]any{"taskId": task.ID, "status": "loading"}}}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := svc.UpsertUserCanvasProject(task.UserID, canvas); err != nil {
				t.Fatal(err)
			}
			input := map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": "data:video/mp4;base64," + base64.StdEncoding.EncodeToString(original)}}
			stored, err := svc.persistTaskGeneratedMediaResult(task, input)
			if err != nil {
				t.Fatal(err)
			}
			video := stored["video"].(map[string]interface{})
			resourceID := stringField(video, "resourceId")
			encoded, err := json.Marshal(stored)
			if err != nil {
				t.Fatal(err)
			}
			task.ResultJSON = string(encoded)
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if err := svc.DeliverSucceededTask(task); err != nil {
				t.Fatal(err)
			}
			closeDBRuntimeMatrix(t, svc, db)

			reopened, db := openDBRuntimeMatrix(t, dataDir)
			defer closeDBRuntimeMatrix(t, reopened, db)
			got, err := reopened.Task(task.UserID, task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.ResultState != localtask.ResultStateReady || len(got.Outputs) != 1 {
				t.Fatalf("reopened result = %s, outputs=%d", got.ResultState, len(got.Outputs))
			}
			output := got.Outputs[0]
			if output.ResourceID != resourceID || output.MaterializedAssetID == "" || output.TargetBinding == nil || output.TargetBinding.NodeID != "h3-output" {
				t.Fatalf("reopened canvas output = %#v", output)
			}
			canvas, err = reopened.UserCanvasProject(task.UserID, task.ProjectID)
			var saved struct {
				Nodes []struct {
					Metadata map[string]any `json:"metadata"`
				} `json:"nodes"`
			}
			if err != nil || json.Unmarshal(canvas, &saved) != nil || len(saved.Nodes) != 1 {
				t.Fatalf("reopened canvas could not be read: %v", err)
			}
			meta := saved.Nodes[0].Metadata
			if meta["status"] != "success" || meta["assetId"] != output.MaterializedAssetID || meta["storageKey"] != "resource:"+resourceID {
				t.Fatalf("real video was not attached to the saved canvas: %#v", meta)
			}
			resource, stream, err := reopened.OpenResource(task.UserID, resourceID)
			if err != nil {
				t.Fatal(err)
			}
			readback, err := io.ReadAll(stream)
			stream.Close()
			if err != nil || !bytes.Equal(readback, original) || resource.Width <= 0 || resource.Height <= 0 || resource.DurationMs < 2000 {
				t.Fatalf("stored playback readback failed: bytes=%d/%d dimensions=%dx%d duration=%d err=%v", len(readback), len(original), resource.Width, resource.Height, resource.DurationMs, err)
			}
			if err := reopened.DeliverSucceededTask(task); err != nil {
				t.Fatal(err)
			}
			again, err := reopened.persistTaskGeneratedMediaResult(task, input)
			if err != nil || stringField(again["video"].(map[string]interface{}), "resourceId") != resourceID {
				t.Fatalf("restart duplicated result resource: %v", err)
			}
			var count int64
			if err := db.Model(&model.Resource{}).Count(&count).Error; err != nil || count != 1 {
				t.Fatalf("resources=%d err=%v", count, err)
			}
			t.Logf("real %s: stored %d bytes, ready canvas binding, SQLite reopen, exact playable resource readback and idempotent recovery", name, len(readback))
		})
	}
}
