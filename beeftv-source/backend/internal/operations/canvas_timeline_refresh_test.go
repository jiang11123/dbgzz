package operations

import (
	"encoding/json"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"reflect"
	"testing"
)

const refreshDocument = `{"id":"canvas","revision":4,"nodes":[{"id":"node","type":"video","metadata":{"resourceId":"media","assetId":"asset"}},{"id":"keep","type":"video","metadata":{"resourceId":"media","assetId":"asset"}}],"timeline":{"version":2,"durationMs":4000,"output":{"width":720,"height":1280,"fps":30},"editorState":{"keep":true},"tracks":[{"id":"v","kind":"video","locked":true},{"id":"s","kind":"subtitle"},{"id":"a","kind":"audio"}],"clips":[{"id":"keep","kind":"video","nodeId":"keep","trackId":"v","startMs":0,"durationMs":2000,"directMedia":{"id":"media","kind":"video","storageKey":"resource:media","assetId":"asset"}},{"id":"replace","kind":"video","nodeId":"node","trackId":"v","startMs":2000,"durationMs":2000,"sourceStartMs":500,"volume":0.3,"custom":{"keep":"exact"},"directMedia":{"id":"old","kind":"video","storageKey":"resource:old","assetId":"old-asset"}},{"id":"voice","kind":"audio","nodeId":"keep","trackId":"a","startMs":500,"durationMs":3000,"volume":0.8,"fadeOutMs":200,"directMedia":{"id":"media","kind":"video","storageKey":"resource:media","assetId":"asset"}},{"id":"caption","kind":"subtitle","trackId":"s","startMs":500,"durationMs":3200,"text":"保持原文\n保持换行","subtitleEntryIndex":0}]}}`

type refreshDomain struct {
	timelineDomain
	duration int64
}

func (d *refreshDomain) OwnedReadyResource(user, id string) (*model.Resource, error) {
	r, err := d.timelineDomain.OwnedReadyResource(user, id)
	if r != nil {
		r.DurationMs = d.duration
	}
	return r, err
}

func TestTimelineRefreshChangesOnlySelectedSource(t *testing.T) {
	d := &refreshDomain{timelineDomain: timelineDomain{doc: json.RawMessage(refreshDocument)}, duration: 5000}
	ctx := &Context{UserID: "owner", Domain: d}
	args := json.RawMessage(`{"canvasId":"canvas","expectedRevision":4,"refreshNodeIds":["node"]}`)
	if _, err := opCanvasTimelineUpdate(ctx, args); err != nil {
		t.Fatal(err)
	}
	var before, after map[string]any
	json.Unmarshal([]byte(refreshDocument), &before)
	json.Unmarshal(d.doc, &after)
	timeline := after["timeline"].(map[string]any)
	clip := timeline["clips"].([]any)[1].(map[string]any)
	media := clip["directMedia"].(map[string]any)
	if media["storageKey"] != "resource:media" || media["assetId"] != "asset" {
		t.Fatalf("wrong new source: %v", media)
	}
	// Compare every saved field, including editor extensions, not only subtitles.
	before["revision"] = after["revision"]
	before["timeline"].(map[string]any)["clips"].([]any)[1].(map[string]any)["directMedia"] = media
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("unrequested edit: %s", d.doc)
	}
	raw, _ := json.Marshal(timeline)
	var project editing.Project
	json.Unmarshal(raw, &project)
	plan, err := editing.Compile(project, nil, editing.Options{})
	if err != nil || plan.Segments[1].SourceID != "media" {
		t.Fatalf("render must use replacement: %v %v", plan, err)
	}
	if _, err := opCanvasTimelineUpdate(ctx, args); err == nil || d.commits != 1 {
		t.Fatal("stale update committed")
	}
}

func TestTimelineRefreshRejectsInvalidEditsWithoutCommit(t *testing.T) {
	for _, tc := range []struct {
		name, fields, user string
		duration           int64
	}{
		{"empty", `"refreshNodeIds":[]`, "owner", 5000},
		{"duplicate", `"refreshNodeIds":["node","node"]`, "owner", 5000},
		{"unused", `"refreshNodeIds":["missing"]`, "owner", 5000},
		{"mixed", `"refreshNodeIds":["node"],"timeline":{"version":2}`, "owner", 5000},
		{"null-mixed", `"refreshNodeIds":["node"],"timeline":null`, "owner", 5000},
		{"shorter", `"refreshNodeIds":["node"]`, "owner", 2000},
		{"foreign", `"refreshNodeIds":["node"]`, "other", 5000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &refreshDomain{timelineDomain: timelineDomain{doc: json.RawMessage(refreshDocument)}, duration: tc.duration}
			_, err := opCanvasTimelineUpdate(&Context{UserID: tc.user, Domain: d}, json.RawMessage(`{"canvasId":"canvas","expectedRevision":4,`+tc.fields+`}`))
			if err == nil || d.commits != 0 || string(d.doc) != refreshDocument {
				t.Fatalf("invalid edit changed project: %v", err)
			}
		})
	}
}
