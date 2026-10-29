package operations

import (
	"encoding/json"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"reflect"
	"testing"
)

type timelineDomain struct {
	unusedDomain
	doc     json.RawMessage
	commits int
}

func (d *timelineDomain) UserCanvasProject(user, id string) (json.RawMessage, error) {
	if user != "owner" || id != "canvas" {
		return nil, PermissionDenied("foreign_canvas", "foreign")
	}
	return d.doc, nil
}
func (d *timelineDomain) OwnedReadyResource(user, id string) (*model.Resource, error) {
	if user != "owner" || id != "media" {
		return nil, PermissionDenied("foreign_resource", "foreign")
	}
	return &model.Resource{ID: id, MimeType: "video/mp4"}, nil
}
func (d *timelineDomain) OwnedAsset(user, id string) (*model.Asset, error) {
	if user != "owner" || id != "asset" {
		return nil, PermissionDenied("foreign_asset", "foreign")
	}
	return &model.Asset{ID: id, UserID: user, PayloadJSON: `{"resourceId":"media"}`}, nil
}
func (d *timelineDomain) CommitUserCanvasDocument(user, id string, revision int64, raw json.RawMessage) (canvas.UserDataSummary, json.RawMessage, error) {
	var doc map[string]any
	json.Unmarshal(d.doc, &doc)
	if canvasRevision(doc) != revision {
		return canvas.UserDataSummary{}, nil, Conflict("revision_conflict", "stale", nil)
	}
	json.Unmarshal(raw, &doc)
	doc["revision"] = float64(revision + 1)
	d.doc, _ = json.Marshal(doc)
	d.commits++
	return canvas.UserDataSummary{Revision: revision + 1}, d.doc, nil
}

func TestTimelineUpdatePreservesOtherFieldsAndRejectsUnauthorizedSources(t *testing.T) {
	initial := json.RawMessage(`{"id":"canvas","revision":4,"title":"unchanged","nodes":[{"id":"node","type":"video","metadata":{"resourceId":"media","assetId":"asset","custom":"keep"}}],"connections":[],"viewport":{"x":13},"plugin":{"arbitrary":"preserved"}}`)
	d := &timelineDomain{doc: initial}
	ctx := &Context{UserID: "owner", Domain: d}
	args := map[string]any{"canvasId": "canvas", "expectedRevision": 4, "timeline": map[string]any{"version": 2, "durationMs": 2000, "tracks": []any{map[string]any{"id": "v", "kind": "video", "muted": true}}, "clips": []any{map[string]any{"id": "clip", "kind": "video", "nodeId": "node", "trackId": "v", "startMs": 0, "durationMs": 2000, "sourceStartMs": 1000, "volume": 0}}}}
	inputTimeline := args["timeline"].(map[string]any)
	inputTimeline["output"] = map[string]any{"width": 720, "height": 1280, "fps": 24}
	inputTimeline["tracks"].([]any)[0].(map[string]any)["label"] = "主画面"
	inputTimeline["tracks"].([]any)[0].(map[string]any)["order"] = 4
	raw, _ := json.Marshal(args)
	result, err := opCanvasTimelineUpdate(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["timelineUpdated"] != true || d.commits != 1 {
		t.Fatalf("no effect %v", result)
	}
	var before, after map[string]any
	json.Unmarshal(initial, &before)
	json.Unmarshal(d.doc, &after)
	var savedTimeline editing.Project
	savedRaw, _ := json.Marshal(after["timeline"])
	if err := json.Unmarshal(savedRaw, &savedTimeline); err != nil {
		t.Fatal(err)
	}
	if savedTimeline.Clips[0].NodeID != "node" || savedTimeline.Clips[0].DirectMedia.StorageKey != "resource:media" {
		t.Fatalf("missing canonical source: %+v", savedTimeline.Clips[0])
	}
	plan, err := editing.Compile(savedTimeline, nil, editing.Options{})
	if err != nil || plan.Segments[0].SourceID != "media" {
		t.Fatalf("native render source incorrect: %+v %v", plan, err)
	}
	if plan.Output.Width != 720 || plan.Output.Height != 1280 || savedTimeline.Tracks[0].Label != "主画面" || savedTimeline.Tracks[0].Order == nil || *savedTimeline.Tracks[0].Order != 4 {
		t.Fatalf("saved timeline lost editable output or tracks: %s", savedRaw)
	}
	delete(after, "timeline")
	after["revision"] = before["revision"]
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("otherfields changed: %s", d.doc)
	}
	if _, err := opCanvasTimelineUpdate(ctx, raw); err == nil {
		t.Fatal("accepted stale revision")
	}
	for _, mutation := range []map[string]any{
		{"nodeId": "foreign"},
		{"nodeId": "", "directMedia": map[string]any{"id": "foreign", "kind": "video", "storageKey": "resource:foreign"}},
		{"nodeId": "", "directMedia": map[string]any{"id": "url", "kind": "video", "storageKey": "https://example.com/a.mp4"}},
		{"nodeId": "node", "directMedia": map[string]any{"id": "foreign", "kind": "video", "storageKey": "resource:foreign"}},
	} {
		d.doc = initial
		timeline := args["timeline"].(map[string]any)
		clip := timeline["clips"].([]any)[0].(map[string]any)
		saved := map[string]any{}
		for k, v := range clip {
			saved[k] = v
		}
		for k, v := range mutation {
			clip[k] = v
		}
		raw, _ = json.Marshal(args)
		if _, err := opCanvasTimelineUpdate(ctx, raw); err == nil {
			t.Fatalf("accepted %+v", mutation)
		}
		timeline["clips"] = []any{saved}
	}
	if d.commits != 1 {
		t.Fatalf("unauthorized write committed: %d", d.commits)
	}
}
