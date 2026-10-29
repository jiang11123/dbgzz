package app

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
)

func TestTimelineSubtitleOnlyUpdateAndRenderKeepSavedPortraitOutput(t *testing.T) {
	_, db := newTimelineTaskTestService(t)
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	svc := NewLocal(repository.New(db), t.TempDir())
	if err := db.Create(&model.Workspace{ID: "owner", Name: "test"}).Error; err != nil {
		t.Fatal(err)
	}
	bin, err := editing.ResolveFFmpegBinary()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "source.mp4")
	if out, err := exec.Command(bin, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=180x320:r=24:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", source).CombinedOutput(); err != nil {
		t.Fatalf("source: %v %s", err, out)
	}
	file, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	stat, _ := file.Stat()
	resource, err := svc.UploadLocalResourceFile("owner", "source.mp4", stat.Size(), "video", 180, 320, 1000, file)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"resourceId": resource.ID})
	if err := db.Create(&model.Asset{ID: "asset", UserID: "owner", Kind: "video", PayloadJSON: string(payload)}).Error; err != nil {
		t.Fatal(err)
	}
	timeline := editing.Project{Version: 2, DurationMs: 1000, Output: &editing.Options{Width: 720, Height: 1280, FPS: 24}, Tracks: []editing.Track{{ID: "v", Kind: "video"}, {ID: "s", Kind: "subtitle"}}, Clips: []editing.Clip{
		{ID: "v", Kind: "video", NodeID: "node", TrackID: "v", DurationMs: 1000, Volume: 1, DirectMedia: &editing.DirectMedia{ID: resource.ID, AssetID: "asset", Kind: "video", StorageKey: "resource:" + resource.ID}},
		{ID: "s", Kind: "subtitle", TrackID: "s", DurationMs: 1000, Text: "原句"},
	}}
	raw, _ := json.Marshal(map[string]any{"id": "canvas", "revision": 0, "title": "portrait", "nodes": []any{map[string]any{"id": "node", "type": "video", "metadata": map[string]any{"storageKey": "resource:" + resource.ID, "assetId": "asset"}}}, "connections": []any{}, "timeline": timeline})
	summary, err := svc.UpsertUserCanvasProject("owner", raw)
	if err != nil {
		t.Fatal(err)
	}
	timeline.Output = nil
	timeline.Clips[1].Text = "修改后的字幕"
	params, _ := json.Marshal(map[string]any{"canvasId": "canvas", "expectedRevision": summary.Revision, "timeline": timeline})
	r := operations.NewRegistry(svc, operations.NewStore(db))
	operations.RegisterDefaultOps(r)
	result, err := r.Execute(operations.Request{UserID: "owner", Caller: operations.Caller{Kind: operations.CallerManual}, Op: "canvas.timeline.update", OpID: "subtitle-edit", Params: params})
	if err != nil {
		t.Fatal(err)
	}
	saved, err := svc.UserCanvasProject("owner", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Timeline editing.Project `json:"timeline"`
	}
	if err := json.Unmarshal(saved, &doc); err != nil {
		t.Fatal(err)
	}
	plan, err := editing.Compile(doc.Timeline, nil, editing.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Output.Width != 720 || plan.Output.Height != 1280 || plan.Output.FPS != 24 {
		t.Fatalf("subtitle-only update lost saved output: %+v", plan.Output)
	}
	params, _ = json.Marshal(map[string]any{"canvasId": "canvas", "expectedRevision": result.Revision})
	result, err = r.Execute(operations.Request{UserID: "owner", Caller: operations.Caller{Kind: operations.CallerManual}, Op: "canvas.timeline.render", OpID: "render-with-saved-output", Params: params})
	if err != nil {
		t.Fatal(err)
	}
	taskID := result.Result.(map[string]any)["taskId"].(string)
	var task model.Task
	if err := db.First(&task, "id = ?", taskID).Error; err != nil {
		t.Fatal(err)
	}
	task.Status = model.TaskStatusRunning
	if err := db.Model(&model.Task{}).Where("id = ?", taskID).Update("status", task.Status).Error; err != nil {
		t.Fatal(err)
	}
	if err := newTaskWorkerCoordinator(svc).processTimelineRender(&task, context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&task, "id = ?", taskID).Error; err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusSucceeded {
		t.Fatalf("render failed: %s %s", task.Stage, task.Error)
	}
	var rendered timelineRenderResult
	if err := json.Unmarshal([]byte(task.ResultJSON), &rendered); err != nil {
		t.Fatal(err)
	}
	_, body, err := svc.OpenResource("owner", rendered.ResourceID)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	output, err := os.Create(filepath.Join(dir, "rendered.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.Copy(output, body); err != nil {
		t.Fatal(err)
	}
	output.Close()
	probe, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", output.Name()).Output()
	if err != nil {
		t.Fatal(err)
	}
	var facts struct {
		Streams []struct {
			Width, Height int
			Rate          string `json:"r_frame_rate"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(probe, &facts); err != nil {
		t.Fatal(err)
	}
	if len(facts.Streams) != 1 || facts.Streams[0].Width != 720 || facts.Streams[0].Height != 1280 || facts.Streams[0].Rate != "24/1" {
		t.Fatalf("actual output changed: %s", probe)
	}
	t.Logf("default render after saved subtitle edit: %s", probe)
}
