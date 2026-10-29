package editing

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func boolPtr(v bool) *bool { return &v }

func clip(id, kind, track string, start, duration int64, source string) Clip {
	item := Clip{ID: id, Kind: kind, NodeID: id, TrackID: track, StartMs: start, DurationMs: duration, Volume: 1}
	if source != "" {
		item.DirectMedia = &DirectMedia{ID: "media-" + id, Kind: kind, StorageKey: source}
	}
	return item
}

func TestCompileExpandsGapAndSorts(t *testing.T) {
	project := Project{
		Version: 2,
		Tracks:  []Track{{ID: "track-video-1", Kind: KindVideo}, {ID: "track-subtitle-1", Kind: KindSubtitle}},
		Clips: []Clip{
			clip("clip-b", KindVideo, "track-video-1", 3000, 2000, "resource:res-b"),
			clip("clip-a", KindVideo, "track-video-1", 0, 2000, "resource:res-a"),
			{ID: "clip-sub", Kind: KindSubtitle, TrackID: "track-subtitle-1", DurationMs: 1000, Text: "hi"},
		},
	}
	plan, err := Compile(project, nil, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if !plan.HasMedia() || len(plan.Segments) != 3 {
		t.Fatalf("segments=%d hasMedia=%v", len(plan.Segments), plan.HasMedia())
	}
	if plan.Segments[0].ClipID != "clip-a" || plan.Segments[1].Kind != KindGap || plan.Segments[1].DurationMs != 1000 || plan.Segments[2].ClipID != "clip-b" {
		t.Fatalf("unexpected segments: %+v", plan.Segments)
	}
	if plan.Segments[0].SourceID != "res-a" || plan.Segments[2].SourceID != "res-b" {
		t.Fatalf("source ids: %s %s", plan.Segments[0].SourceID, plan.Segments[2].SourceID)
	}
}

func TestCompileSkipsHiddenTrack(t *testing.T) {
	hidden := false
	project := Project{
		Version: 2,
		Tracks:  []Track{{ID: "track-hidden", Kind: KindVideo, Visible: &hidden}},
		Clips:   []Clip{clip("clip-hidden", KindVideo, "track-hidden", 0, 1000, "resource:res-x")},
	}
	_, err := Compile(project, nil, DefaultOptions())
	if !errors.Is(err, ErrNoMedia) {
		t.Fatalf("err=%v want ErrNoMedia", err)
	}
}

func TestCompileIncludesMutedAudioAndImages(t *testing.T) {
	project := Project{
		Version:    2,
		DurationMs: 2000,
		Tracks:     []Track{{ID: "v"}, {ID: "a", Muted: true}, {ID: "img"}},
		Clips: []Clip{
			clip("v", KindVideo, "v", 0, 1000, "resource:v"),
			clip("still", KindImage, "img", 1000, 1000, "resource:img"),
			clip("voice", KindAudio, "a", 0, 1000, "resource:a"),
		},
	}
	plan, err := Compile(project, nil, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Segments) != 2 || plan.Segments[1].Kind != KindImage {
		t.Fatalf("segments=%+v", plan.Segments)
	}
	if len(plan.Audio) != 1 || !plan.Audio[0].Muted {
		t.Fatalf("muted audio dropped: %+v", plan.Audio)
	}
}

func TestCompileOverlapAndNegativeTime(t *testing.T) {
	project := Project{
		Version: 2,
		Tracks:  []Track{{ID: "v"}},
		Clips: []Clip{
			clip("a", KindVideo, "v", 0, 2000, "resource:a"),
			clip("b", KindVideo, "v", 1000, 1000, "resource:b"),
		},
	}
	if _, err := Compile(project, nil, DefaultOptions()); !errors.Is(err, ErrOverlap) {
		t.Fatalf("overlap err=%v", err)
	}
	neg := Project{Version: 2, Tracks: []Track{{ID: "v"}}, Clips: []Clip{clip("a", KindVideo, "v", -1, 1000, "resource:a")}}
	if _, err := Compile(neg, nil, DefaultOptions()); !errors.Is(err, ErrNegativeTime) {
		t.Fatalf("negative err=%v", err)
	}
}

func TestCompileRequiresOpaqueSourcesWhenProvided(t *testing.T) {
	project := Project{
		Version: 2,
		Tracks:  []Track{{ID: "v"}},
		Clips:   []Clip{clip("a", KindVideo, "v", 0, 1000, "resource:a")},
	}
	project.Clips[0].NodeID = "node-a"
	_, err := Compile(project, []SourceMeta{}, DefaultOptions())
	if !errors.Is(err, ErrMissingSource) {
		t.Fatalf("err=%v", err)
	}
	hasAudio := true
	hasVideo := true
	plan, err := Compile(project, []SourceMeta{{ID: "node-a", HasAudio: &hasAudio, HasVideo: &hasVideo, DurationMs: 5000}}, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if plan.Segments[0].SourceID != "node-a" || !plan.Segments[0].HasAudio {
		t.Fatalf("browser source id not preserved: %+v", plan.Segments[0])
	}
}

func TestCompileRejectsNativePathKeys(t *testing.T) {
	project := Project{
		Version: 2,
		Tracks:  []Track{{ID: "v"}},
		Clips:   []Clip{clip("a", KindVideo, "v", 0, 1000, "/tmp/secret.mp4")},
	}
	if _, err := Compile(project, nil, DefaultOptions()); !errors.Is(err, ErrMissingMediaRef) {
		t.Fatalf("path key accepted: %v", err)
	}
}

func TestCompileVolumeZeroAndSubtitleSRT(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want float64
	}{{`{}`, 1}, {`{"volume":0}`, 0}, {`{"volume":0.25}`, 0.25}} {
		var item Clip
		if err := json.Unmarshal([]byte(tc.raw), &item); err != nil || item.Volume != tc.want {
			t.Fatalf("volume %s: %v/%v", tc.raw, item.Volume, err)
		}
	}
	hidden := false
	project := Project{
		Version:    2,
		DurationMs: 6000,
		Tracks:     []Track{{ID: "v"}, {ID: "a", Muted: true}, {ID: "s", Visible: &hidden}},
		Clips: []Clip{
			clip("v", KindVideo, "v", 0, 6000, "resource:v"),
			clip("a", KindAudio, "a", 1000, 2000, "resource:a"),
			{ID: "s", Kind: KindSubtitle, TrackID: "s", DurationMs: 1000, Text: "隐藏"},
			{ID: "sub-b", Kind: KindSubtitle, TrackID: "v", StartMs: 2000, DurationMs: 1000, Text: "第二条"},
			{ID: "sub-a", Kind: KindSubtitle, TrackID: "v", StartMs: 0, DurationMs: 1000, Text: "第一条"},
			{ID: "sub-blank", Kind: KindSubtitle, TrackID: "s", StartMs: 5000, DurationMs: 1000, Text: "   "},
		},
	}
	plan, err := Compile(project, nil, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Audio) != 1 || !plan.Audio[0].Muted {
		t.Fatalf("audio %+v", plan.Audio)
	}
	want := "1\n00:00:00,000 --> 00:00:01,000\n第一条\n\n2\n00:00:02,000 --> 00:00:03,000\n第二条\n\n"
	if plan.SubtitleSRT != want {
		t.Fatalf("srt=%q want %q", plan.SubtitleSRT, want)
	}
}

func TestCompileTrailingGapFromAudioAndProjectDuration(t *testing.T) {
	project := Project{
		Version:    2,
		DurationMs: 5000,
		Tracks:     []Track{{ID: "v"}, {ID: "a"}},
		Clips: []Clip{
			clip("v", KindVideo, "v", 0, 2000, "resource:v"),
			clip("a", KindAudio, "a", 0, 4000, "resource:a"),
		},
	}
	plan, err := Compile(project, nil, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Segments) != 2 || plan.Segments[1].Kind != KindGap || plan.Segments[1].DurationMs != 3000 || plan.DurationMs != 5000 {
		t.Fatalf("trailing gap missing: %+v dur=%d", plan.Segments, plan.DurationMs)
	}
}

func TestApplySourceFactsSilentVideoAndDuration(t *testing.T) {
	project := Project{
		Version: 2,
		Tracks:  []Track{{ID: "v"}, {ID: "a"}},
		Clips: []Clip{
			func() Clip {
				c := clip("v", KindVideo, "v", 0, 1000, "resource:v")
				c.SourceStartMs = 500
				return c
			}(),
			clip("voice", KindAudio, "a", 0, 1000, "resource:a"),
		},
	}
	plan, err := Compile(project, nil, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := ApplySourceFacts(plan, map[string]SourceFacts{
		"v": {HasVideo: true, HasAudio: false, DurationMs: 2000},
		"a": {HasAudio: true, DurationMs: 2000},
	}); err != nil {
		t.Fatal(err)
	}
	if plan.Segments[0].HasAudio {
		t.Fatal("silent video kept audio")
	}
	if err := ApplySourceFacts(plan, map[string]SourceFacts{
		"v": {HasVideo: true, HasAudio: true, DurationMs: 1000},
		"a": {HasAudio: true, DurationMs: 2000},
	}); !errors.Is(err, ErrInsufficientDuration) {
		t.Fatalf("short source err=%v", err)
	}
}

func TestCompileSharedGapMixFixture(t *testing.T) {
	assertFixturePlan(t, "gap-mix.timeline.json", "gap-mix.plan.json")
}

func TestCompileSharedSixSecondMixFixture(t *testing.T) {
	assertFixturePlan(t, "six-second-mix.timeline.json", "six-second-mix.plan.json")
}

func TestCompileSharedGapSilentFadeFixture(t *testing.T) {
	assertFixturePlan(t, "gap-silent-fade.timeline.json", "gap-silent-fade.plan.json")
}

func TestCompileSharedImageGapSubFixture(t *testing.T) {
	assertFixturePlan(t, "image-gap-sub.timeline.json", "image-gap-sub.plan.json")
}

func assertFixturePlan(t *testing.T, timelineName, planName string) {
	t.Helper()
	root := testdataRoot(t)
	timelineRaw, err := os.ReadFile(filepath.Join(root, timelineName))
	if err != nil {
		t.Fatal(err)
	}
	planRaw, err := os.ReadFile(filepath.Join(root, planName))
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Timeline Project      `json:"timeline"`
		Sources  []SourceMeta `json:"sources"`
		Options  Options      `json:"options"`
	}
	if err := json.Unmarshal(timelineRaw, &payload); err != nil {
		t.Fatal(err)
	}
	got, err := Compile(payload.Timeline, payload.Sources, payload.Options)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var want, actual any
	if err := json.Unmarshal(planRaw, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &actual); err != nil {
		t.Fatal(err)
	}
	wantJSON, _ := json.Marshal(want)
	gotJSON, _ := json.Marshal(actual)
	if string(wantJSON) != string(gotJSON) {
		t.Fatalf("fixture drift %s\ngot  %s\nwant %s", timelineName, gotJSON, wantJSON)
	}
}

func testdataRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 6; i++ {
		candidate := filepath.Join(dir, "fixtures", "editing")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("fixtures/editing not found")
	return ""
}

func TestCompilePreflightRejectsMalformed(t *testing.T) {
	valid := clip("v", KindVideo, "v", 0, 1000, "resource:v")
	base := Project{Version: 2, Tracks: []Track{{ID: "v"}}, Clips: []Clip{valid}}
	if _, err := Compile(base, nil, DefaultOptions()); err != nil {
		t.Fatal(err)
	}

	noVersion := base
	noVersion.Version = 1
	if _, err := Compile(noVersion, nil, DefaultOptions()); !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("version err=%v", err)
	}

	dup := base
	dup.Clips = []Clip{valid, clip("v", KindVideo, "v", 2000, 1000, "resource:v2")}
	if _, err := Compile(dup, nil, DefaultOptions()); !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("dup err=%v", err)
	}

	unknownKind := base
	unknownKind.Clips = []Clip{{ID: "t", Kind: "text", TrackID: "v", StartMs: 0, DurationMs: 1000, Volume: 1}}
	if _, err := Compile(unknownKind, nil, DefaultOptions()); !errors.Is(err, ErrUnsupportedKind) {
		t.Fatalf("kind err=%v", err)
	}

	zeroDur := base
	zeroDur.Clips = []Clip{clip("v", KindVideo, "v", 0, 0, "resource:v")}
	if _, err := Compile(zeroDur, nil, DefaultOptions()); !errors.Is(err, ErrInvalidClip) {
		t.Fatalf("zero duration err=%v", err)
	}

	unknownTrack := base
	unknownTrack.Clips = []Clip{clip("v", KindVideo, "missing", 0, 1000, "resource:v")}
	if _, err := Compile(unknownTrack, nil, DefaultOptions()); !errors.Is(err, ErrUnknownTrack) {
		t.Fatalf("track err=%v", err)
	}

	emptySub := Project{
		Version: 2,
		Tracks:  []Track{{ID: "v"}, {ID: "s"}},
		Clips: []Clip{
			valid,
			{ID: "sub", Kind: KindSubtitle, TrackID: "s", DurationMs: 1000, Text: "  "},
		},
	}
	if _, err := Compile(emptySub, nil, DefaultOptions()); !errors.Is(err, ErrInvalidClip) {
		t.Fatalf("empty subtitle err=%v", err)
	}

	hidden := false
	hiddenBad := Project{
		Version: 2,
		Tracks:  []Track{{ID: "v"}, {ID: "h", Visible: &hidden}},
		Clips: []Clip{
			valid,
			{ID: "bad", Kind: "text", TrackID: "h", DurationMs: 0},
		},
	}
	if _, err := Compile(hiddenBad, nil, DefaultOptions()); err != nil {
		t.Fatalf("hidden malformed clip should be omitted: %v", err)
	}

	if _, err := Compile(base, nil, Options{Width: 3, Height: 1080, FPS: 30, SampleRate: 44100}); !errors.Is(err, ErrInvalidOutput) {
		t.Fatalf("odd width err=%v", err)
	}
	if _, err := Compile(base, nil, Options{Width: 1920, Height: 1080, FPS: 0, SampleRate: 44100}); err != nil {
		t.Fatalf("zero fps should default: %v", err)
	}
	if _, err := Compile(base, nil, Options{Width: 1920, Height: 1080, FPS: 240, SampleRate: 44100}); !errors.Is(err, ErrInvalidOutput) {
		t.Fatalf("fps err=%v", err)
	}
	if _, err := Compile(base, nil, Options{Width: 1920, Height: 1080, FPS: 30, SampleRate: 1000}); !errors.Is(err, ErrInvalidOutput) {
		t.Fatalf("rate err=%v", err)
	}
	if _, err := Compile(base, nil, Options{Width: 9000, Height: 1080, FPS: 30, SampleRate: 44100}); !errors.Is(err, ErrInvalidOutput) {
		t.Fatalf("huge width err=%v", err)
	}

	overflow := base
	overflow.Clips = []Clip{clip("v", KindVideo, "v", MaxDurationMs-10, 100, "resource:v")}
	if _, err := Compile(overflow, nil, DefaultOptions()); !errors.Is(err, ErrInvalidDuration) {
		t.Fatalf("overflow err=%v", err)
	}
}

func TestFormatSRTTimestamp(t *testing.T) {
	if got := FormatSRTTimestamp(3_600_000 + 60_000 + 1_234); got != "01:01:01,234" {
		t.Fatalf("got %s", got)
	}
	if got := FormatSRTTimestamp(-1); got != "00:00:00,000" {
		t.Fatalf("got %s", got)
	}
}
