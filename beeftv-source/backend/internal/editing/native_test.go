package editing

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBoundedEncoderLogRetainsEarlySplitFontFailure(t *testing.T) {
	log := &ffmpegLogTail{max: 64 << 10}
	_, _ = log.Write([]byte("[libass] failed to find any fall"))
	_, _ = log.Write([]byte("back font\n"))
	_, _ = log.Write([]byte(strings.Repeat("frame=100 encoding progress\n", 5000)))
	if len(log.Text()) > 64<<10 {
		t.Fatal("encoder log exceeded its bound")
	}
	if strings.Contains(log.Text(), "fallback") {
		t.Fatal("fixture did not evict early warning")
	}
	if !log.FontFailure() {
		t.Fatal("long encoding hid a subtitle font failure")
	}
}

func TestBuildFFmpegArgsLayout(t *testing.T) {
	plan, err := Compile(Project{
		Version: 2,
		Tracks:  []Track{{ID: "track-video-1", Kind: KindVideo}},
		Clips: []Clip{
			clip("clip-a", KindVideo, "track-video-1", 0, 2000, "resource:res-a"),
			clip("clip-b", KindVideo, "track-video-1", 5000, 1000, "resource:res-b"),
		},
	}, nil, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	plan.Segments[0].HasAudio = true
	plan.Segments[2].HasAudio = true
	files := map[string]string{plan.Segments[0].SourceID: "src-0.mp4", plan.Segments[2].SourceID: "src-1.mp4"}

	args := BuildFFmpegArgs(*plan, files, "render-output.mp4")
	joined := strings.Join(args, " ")
	if len(args) == 0 {
		t.Fatal("args empty, want ffmpeg arguments")
	}
	for _, want := range []string{
		"-filter_complex",
		"concat=n=3:v=1:a=1",
		"[vout]", "[aout]",
		"libx264", "aac",
		"color=c=black:s=1920x1080:r=30",
		"anullsrc=r=44100:cl=stereo",
		"render-output.mp4",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q: %s", want, joined)
		}
	}
	if !strings.Contains(joined, "[5:a]") {
		t.Fatalf("args missing final audio input label [5:a]: %s", joined)
	}
	if BuildFFmpegArgs(Plan{}, nil, "out.mp4") != nil {
		t.Fatal("args for empty plan: want nil")
	}
}

func TestBuildFFmpegArgsSilentFallbackUniqueLabels(t *testing.T) {
	plan := Plan{
		Output:     Output{Width: 1920, Height: 1080, FPS: 30, SampleRate: 44100},
		DurationMs: 2000,
		Segments: []Segment{
			{Kind: KindVideo, SourceID: "a", DurationMs: 1000, HasAudio: false, Volume: 1},
			{Kind: KindVideo, SourceID: "b", DurationMs: 1000, HasAudio: false, Volume: 1},
		},
	}
	args := BuildFFmpegArgs(plan, map[string]string{"a": "src-0.mp4", "b": "src-1.mp4"}, "out.mp4")
	joined := strings.Join(args, " ")
	if strings.Count(joined, "-i anullsrc=") != 2 || strings.Count(joined, "apad,atrim=duration=1.000") != 2 {
		t.Fatalf("silent labels not unique: %s", joined)
	}
}

func TestBuildFFmpegArgsMissingSourceReturnsNil(t *testing.T) {
	plan := Plan{
		Output:     Output{Width: 1920, Height: 1080, FPS: 30, SampleRate: 44100},
		DurationMs: 1000,
		Segments:   []Segment{{Kind: KindVideo, SourceID: "missing", DurationMs: 1000, Volume: 1}},
	}
	if args := BuildFFmpegArgs(plan, nil, "x.mp4"); args != nil {
		t.Fatal("missing source must fail")
	}
}

func TestSubtitleFontFailure(t *testing.T) {
	if !SubtitleFontFailure("fontselect: failed to find any fallback with glyph 0x4E2D") || SubtitleFontFailure("fontselect: using Chinese font") {
		t.Fatal("font failure detection")
	}
	for _, message := range []string{
		"can't find selected font provider", "fontselect: failed to find any fallback with glyph 0x4E2D",
		"couldn't find font family", "missing glyph 0x4E2D", "no fonts found",
	} {
		if !SubtitleFontFailure(message) {
			t.Fatalf("successful exit masked missing subtitles: %s", message)
		}
	}
	for _, normal := range []string{
		"Glyph 0x4E2D not found, selecting one more font for (Arial, 400, 0)",
		"fontselect: (Arial, 400, 0) -> NotoSansCJK, 0, NotoSansCJK",
	} {
		if SubtitleFontFailure(normal) {
			t.Fatalf("normal fallback rejected: %s", normal)
		}
	}
}

type fileSources map[string]string

func (s fileSources) Open(_ context.Context, sourceID string) (io.ReadCloser, error) {
	path := s[sourceID]
	if path == "" {
		return nil, os.ErrNotExist
	}
	return os.Open(path)
}

func TestRendererMaterializeMissingSource(t *testing.T) {
	plan := &Plan{Segments: []Segment{{Kind: KindVideo, ClipID: "missing", SourceID: "missing", DurationMs: 1000, Volume: 1}}}
	// materialize runs only after the binary lookup. A sentinel path skips the
	// host ffmpeg search, so a missing source still fails closed without ffmpeg.
	renderer := &Renderer{FFmpeg: "/no/such/ffmpeg"}
	if _, cleanup, err := renderer.Render(context.Background(), plan, nil); err == nil {
		if cleanup != nil {
			cleanup()
		}
		t.Fatal("missing reference accepted")
	} else if !strings.Contains(err.Error(), "时间线引用的媒体") && err != ErrNoMedia {
		t.Fatalf("err=%v", err)
	}
}

func TestRendererRejectsEmptyPlan(t *testing.T) {
	renderer := &Renderer{FFmpeg: "/no/such/ffmpeg"}
	if _, cleanup, err := renderer.Render(context.Background(), &Plan{}, nil); err != ErrNoMedia {
		if cleanup != nil {
			cleanup()
		}
		t.Fatalf("err=%v want ErrNoMedia", err)
	}
}

func TestRendererRejectsNonMediaFakeOutput(t *testing.T) {
	src := requireTinyAVSource(t)
	plan := shortVideoPlan()
	renderer := &Renderer{FFmpeg: writeFakeFFmpeg(t, `out=""; for arg in "$@"; do out=$arg; done; printf 'not-a-media-file' > "$out"; exit 0`), Sources: fileSources{"src": src}}
	_, cleanup, err := renderer.Render(context.Background(), plan, nil)
	if cleanup != nil {
		cleanup()
	}
	if err == nil || !strings.Contains(err.Error(), "有效媒体") {
		t.Fatalf("err=%v, want non-media output rejected", err)
	}
}

func TestRendererKeepsBoundedFFmpegLogOnFailure(t *testing.T) {
	src := requireTinyAVSource(t)
	plan := shortVideoPlan()
	renderer := &Renderer{FFmpeg: writeFakeFFmpeg(t, `
i=0
while [ "$i" -lt 8000 ]; do
  printf 'ffmpeg debug line %s padding-padding-padding-padding\n' "$i" >&2
  i=$((i+1))
done
printf 'UNIQUE_TAIL_MARKER_boom\n' >&2
exit 1
`), Sources: fileSources{"src": src}}
	_, cleanup, err := renderer.Render(context.Background(), plan, nil)
	if cleanup != nil {
		cleanup()
	}
	if err == nil {
		t.Fatal("want ffmpeg failure")
	}
	message := err.Error()
	if !strings.Contains(message, "UNIQUE_TAIL_MARKER_boom") {
		t.Fatalf("error missing log tail: %s", message)
	}
	if len(message) > 600 {
		t.Fatalf("error retained unbounded stderr: %d bytes", len(message))
	}
}

func TestOutputDurationWithinPlanAllowsEncoderSlack(t *testing.T) {
	if !outputDurationWithinPlan(1000, 1080, 30) || !outputDurationWithinPlan(1000, 920, 30) {
		t.Fatal("normal container slack rejected")
	}
	if outputDurationWithinPlan(1000, 2000, 30) || outputDurationWithinPlan(1000, 0, 30) || outputDurationWithinPlan(0, 1000, 30) {
		t.Fatal("large duration drift accepted")
	}
}

func TestRendererAcceptsOneFrameAtSupportedLowFPS(t *testing.T) {
	src := requireTinyAVSource(t)
	plan := shortVideoPlan()
	plan.Output.FPS = 1
	plan.DurationMs = 500
	plan.Segments[0].DurationMs = 500
	renderer := &Renderer{Sources: fileSources{"src": src}}
	output, cleanup, err := renderer.Render(context.Background(), plan, nil)
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		t.Fatalf("supported 1 fps plan rejected: %v", err)
	}
	if output.DurationMs <= 0 {
		t.Fatal("empty duration")
	}
}

func shortVideoPlan() *Plan {
	return &Plan{
		Output:     Output{Width: 320, Height: 180, FPS: 30, SampleRate: 44100},
		DurationMs: 1000,
		Segments:   []Segment{{Kind: KindVideo, ClipID: "v", SourceID: "src", DurationMs: 1000, Volume: 1}},
	}
}

func writeFakeFFmpeg(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ffmpeg")
	body := "#!/bin/sh\n" + script + "\n"
	if err := os.WriteFile(path, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func requireTinyAVSource(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe required")
	}
	src := filepath.Join(t.TempDir(), "source.mp4")
	cmd := exec.Command("ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", src)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("source fixture: %v %s", err, out)
	}
	return src
}
