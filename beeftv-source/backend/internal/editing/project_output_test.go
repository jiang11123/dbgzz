package editing

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestProjectOutputSurvivesSaveAndExplicitOverride(t *testing.T) {
	raw := []byte(`{"version":2,"output":{"width":720,"height":1280,"fps":24,"sampleRate":48000,"burnSubtitles":false},"tracks":[{"id":"sub","kind":"subtitle","label":"片尾字幕","order":4,"locked":true}],"clips":[{"id":"s","kind":"subtitle","trackId":"sub","startMs":0,"durationMs":1000,"text":"旧句","title":"片尾","subtitleEntryIndex":0}],"durationMs":1000}`)
	var project Project
	if err := json.Unmarshal(raw, &project); err != nil {
		t.Fatal(err)
	}
	project.Tracks = append(project.Tracks, Track{ID: "v", Kind: KindImage})
	project.Clips = append(project.Clips, Clip{ID: "v", Kind: KindImage, TrackID: "v", DurationMs: 1000, Volume: 1, DirectMedia: &DirectMedia{StorageKey: "resource:image"}})
	project.Clips[0].Text = "新句"
	saved, _ := json.Marshal(project)
	var reopened Project
	if err := json.Unmarshal(saved, &reopened); err != nil {
		t.Fatal(err)
	}
	plan, err := Compile(reopened, nil, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Output.Width != 720 || plan.Output.Height != 1280 || plan.Output.FPS != 24 || plan.Output.SampleRate != 48000 || plan.Output.BurnSubtitles {
		t.Fatalf("lost saved output %+v", plan.Output)
	}
	if reopened.Tracks[0].Label != "片尾字幕" || reopened.Tracks[0].Order == nil || *reopened.Tracks[0].Order != 4 || !reopened.Tracks[0].Locked || reopened.Clips[0].Title != "片尾" || reopened.Clips[0].SubtitleEntryIndex == nil || *reopened.Clips[0].SubtitleEntryIndex != 0 {
		t.Fatalf("lost editable fields: %s", saved)
	}
	plan, err = Compile(reopened, nil, Options{Width: 1080, Height: 1920})
	if err != nil || plan.Output.Width != 1080 || plan.Output.Height != 1920 || plan.Output.FPS != 24 {
		t.Fatalf("override %+v %v", plan, err)
	}
	reopened.Output.Width = 721
	if _, err := Compile(reopened, nil, Options{}); !errors.Is(err, ErrInvalidOutput) {
		t.Fatalf("accepted invalid persisted output: %v", err)
	}
}
