package operations

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/editing"
)

func TestTimelineUpdatePreservesOnlyOmittedValidOutput(t *testing.T) {
	for _, tc := range []struct {
		name               string
		priorOutput        string
		requestedOutput    string
		width, height, fps int
		cleared            bool
	}{
		{name: "omitted retains portrait", priorOutput: `{"width":720,"height":1280,"fps":24}`, width: 720, height: 1280, fps: 24},
		{name: "explicit overrides", priorOutput: `{"width":720,"height":1280,"fps":24}`, requestedOutput: `,"output":{"width":1080,"height":1920,"fps":30}`, width: 1080, height: 1920, fps: 30},
		{name: "explicit null clears", priorOutput: `{"width":720,"height":1280,"fps":24}`, requestedOutput: `,"output":null`, width: 1920, height: 1080, fps: 30, cleared: true},
		{name: "invalid prior not inherited", priorOutput: `{"width":721,"height":1280,"fps":24}`, width: 1920, height: 1080, fps: 30, cleared: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &timelineDomain{doc: json.RawMessage(`{"id":"canvas","revision":4,"nodes":[{"id":"node","type":"video","metadata":{"resourceId":"media","assetId":"asset"}}],"timeline":{"version":2,"output":` + tc.priorOutput + `,"tracks":[{"id":"old","kind":"video"}],"clips":[],"durationMs":2000}}`)}
			raw := json.RawMessage(`{"canvasId":"canvas","expectedRevision":4,"timeline":{"version":2,"tracks":[{"id":"v","kind":"video"},{"id":"s","kind":"subtitle"}],"clips":[{"id":"v","kind":"video","nodeId":"node","trackId":"v","startMs":0,"durationMs":1000},{"id":"s","kind":"subtitle","trackId":"s","startMs":0,"durationMs":1000,"text":"改过的一句字幕"}],"durationMs":1000` + tc.requestedOutput + `}}`)
			if _, err := opCanvasTimelineUpdate(&Context{UserID: "owner", Domain: d}, raw); err != nil {
				t.Fatal(err)
			}
			var doc struct {
				Timeline editing.Project `json:"timeline"`
			}
			if err := json.Unmarshal(d.doc, &doc); err != nil {
				t.Fatal(err)
			}
			plan, err := editing.Compile(doc.Timeline, nil, editing.Options{})
			if err != nil {
				t.Fatal(err)
			}
			if plan.Output.Width != tc.width || plan.Output.Height != tc.height || plan.Output.FPS != tc.fps {
				t.Fatalf("output changed: %+v", plan.Output)
			}
			if (doc.Timeline.Output == nil) != tc.cleared {
				t.Fatalf("wrong saved output: %+v", doc.Timeline.Output)
			}
			if len(doc.Timeline.Tracks) != 2 || doc.Timeline.Tracks[0].ID != "v" || len(doc.Timeline.Clips) != 2 || plan.Subtitles[0].Text != "改过的一句字幕" || doc.Timeline.DurationMs != 1000 {
				t.Fatal("update merged unrelated old timeline fields")
			}
		})
	}
}
