package app

import (
	"encoding/json"
	"math"
	"testing"

	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
)

func TestCanvasWorkflowLocalMediaAdmission(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	for _, id := range []string{"video-a", "video-b"} {
		seedResource(t, db, id, "owner", "video/mp4")
		if err := db.Model(&model.Resource{}).Where("id = ?", id).Updates(map[string]any{"duration_ms": 5000, "width": 1280, "height": 720}).Error; err != nil {
			t.Fatal(err)
		}
	}
	steps := map[string]*cw.Step{
		"a": {Status: "succeeded", ResourceID: "video-a"},
		"b": {Status: "succeeded", ResourceID: "video-b"},
	}
	task, err := svc.executeCanvasWorkflowMedia("owner", "merge-op", cw.Node{ID: "merge", OperationID: "video.merge"}, []cw.Edge{
		{From: "a", To: "merge", Order: 2}, {From: "b", To: "merge", Order: 1},
	}, steps)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.First(task, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	var input timelineRenderInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if task.Provider != "local" || task.Model != "ffmpeg" || task.Status != model.TaskStatusQueued || input.Timeline.DurationMs != 10000 || len(input.Timeline.Clips) != 2 {
		t.Fatalf("unexpected task %s/%s/%s or timeline %+v", task.Provider, task.Model, task.Status, input.Timeline)
	}
	if input.Timeline.Clips[0].DirectMedia.StorageKey != "resource:video-b" || input.Timeline.Clips[1].StartMs != 5000 {
		t.Fatalf("merge input order not preserved: %+v", input.Timeline.Clips)
	}
	trim := cw.Node{ID: "trim", OperationID: "video.trim", Config: map[string]any{"startSeconds": 1.25, "endSeconds": 3.5}}
	task, err = svc.executeCanvasWorkflowMedia("owner", "trim-operation", trim, []cw.Edge{{From: "a", To: "trim"}}, steps)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.First(task, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	clip := input.Timeline.Clips[0]
	if clip.SourceStartMs != 1250 || clip.DurationMs != 2250 || input.Options.Width != 1280 || input.Options.Height != 720 {
		t.Fatalf("unexpected trim input: %+v", input)
	}
	trim.Config["endSeconds"] = 6.0
	if _, err := svc.executeCanvasWorkflowMedia("owner", "invalid-trim", trim, []cw.Edge{{From: "a", To: "trim"}}, steps); err == nil {
		t.Fatal("accepted a trim beyond the video duration")
	}
	if _, err := svc.executeCanvasWorkflowMedia("another-user", "foreign-trim", trim, []cw.Edge{{From: "a", To: "trim"}}, steps); err == nil {
		t.Fatal("accepted another user's resource")
	}
}

func TestCanvasWorkflowSecondsRejectsInvalidValues(t *testing.T) {
	for _, value := range []any{nil, "1", -1.0, math.NaN(), math.Inf(1), 43201.0} {
		if _, err := canvasWorkflowSeconds(value); err == nil {
			t.Fatalf("accepted invalid time %v", value)
		}
	}
	if got, err := canvasWorkflowSeconds(json.Number("1.125")); err != nil || got != 1125 {
		t.Fatalf("milliseconds = %d, error = %v", got, err)
	}
}
