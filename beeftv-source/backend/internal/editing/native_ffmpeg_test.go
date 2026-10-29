package editing

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSubtitleFontFailureWithSuccessfulExit(t *testing.T) {
	for _, message := range []string{
		"can't find selected font provider", "fontselect: failed to find any fallback with glyph 0x4E2D",
		"couldn't find font family", "missing glyph 0x4E2D", "no fonts found",
	} {
		t.Run(message, func(t *testing.T) {
			cmd := exec.Command("/bin/sh", "-c", `printf '%s\n' "$1" >&2; exit 0`, "font-fixture", message)
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("fixture must exit zero: %v", err)
			}
			if !SubtitleFontFailure(string(output)) {
				t.Fatalf("successful exit masked missing subtitles: %s", output)
			}
		})
	}
}

func TestRenderFFmpegSixSecondAudioAndChineseSubtitles(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is required for media integration test")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	dir := t.TempDir()
	run := func(args ...string) []byte {
		t.Helper()
		cmd := exec.CommandContext(ctx, ffmpeg, args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("ffmpeg failed: %v\n%s", err, out)
		}
		return out
	}
	run("-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=6", "-f", "lavfi", "-i", "sine=frequency=220:duration=6", "-c:v", "libx264", "-c:a", "pcm_s16le", "source.mkv")
	for _, tone := range []struct {
		freq string
		file string
	}{{"440", "voice.wav"}, {"880", "bgm.wav"}} {
		run("-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency="+tone.freq+":duration=6", tone.file)
	}
	project := Project{Version: 2, DurationMs: 6000, Tracks: []Track{{ID: "v"}, {ID: "a"}, {ID: "s"}}}
	for i := 0; i < 3; i++ {
		item := clip(string(rune('a'+i)), KindVideo, "v", int64(i*2000), 2000, "resource:video")
		item.SourceStartMs = int64(i * 2000)
		project.Clips = append(project.Clips, item)
	}
	voice := clip("voice", KindAudio, "a", 1000, 2000, "resource:voice")
	voice.SourceStartMs = 1000
	bgm := clip("bgm", KindAudio, "a", 0, 6000, "resource:bgm")
	bgm.Volume = 0.2
	project.Clips = append(project.Clips, voice, bgm, Clip{ID: "sub", Kind: KindSubtitle, TrackID: "s", StartMs: 1000, DurationMs: 2000, Text: "中文成片验证"})
	plan, err := Compile(project, nil, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{"video": "source.mkv", "voice": "voice.wav", "bgm": "bgm.wav"}
	if err := ApplySourceFacts(plan, map[string]SourceFacts{
		"video": {HasVideo: true, HasAudio: true, DurationMs: 6000},
		"voice": {HasAudio: true, DurationMs: 6000},
		"bgm":   {HasAudio: true, DurationMs: 6000},
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, SubtitleFileName), []byte(plan.SubtitleSRT), 0600); err != nil {
		t.Fatal(err)
	}
	log := run(BuildFFmpegArgs(*plan, files, "output.mp4")...)
	if strings.Contains(string(log), "failed to find any fallback") {
		t.Fatalf("missing Chinese font: %s", log)
	}
	cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-i", filepath.Join(dir, "output.mp4"), "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "-")
	pcm, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	seconds := float64(len(pcm)/4) / 44100
	if math.Abs(seconds-6) > 0.06 {
		t.Fatalf("duration = %f", seconds)
	}
	amplitude := func(start float64, freq float64) float64 {
		var real, imag float64
		n := 22050
		offset := int(start * 44100)
		for i := 0; i < n; i++ {
			v := float64(math.Float32frombits(binary.LittleEndian.Uint32(pcm[(offset+i)*4:])))
			phase := 2 * math.Pi * freq * float64(i) / 44100
			real += v * math.Cos(phase)
			imag += v * math.Sin(phase)
		}
		return 2 * math.Hypot(real, imag) / float64(n)
	}
	for _, start := range []float64{0.25, 1.25, 2.25, 3.25, 5.25} {
		base, voiceAmp, bgmAmp := amplitude(start, 220), amplitude(start, 440), amplitude(start, 880)
		t.Logf("%.2fs: 220=%.5f 440=%.5f 880=%.5f", start, base, voiceAmp, bgmAmp)
		if base < 0.06 || bgmAmp < 0.008 || bgmAmp > base*0.35 {
			t.Fatal("original audio/BGM lost or wrong volume")
		}
		if start >= 1 && start < 3 {
			if voiceAmp < 0.06 {
				t.Fatal("voice missing")
			}
		} else if voiceAmp > 0.003 {
			t.Fatal("voice outside 1–3s")
		}
	}
	for i := range plan.Segments {
		plan.Segments[i].Muted = true
	}
	plan.Audio[0].Volume = 0
	plan.Audio[1].Muted = true
	run(BuildFFmpegArgs(*plan, files, "muted.mp4")...)
	mutedCmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-i", filepath.Join(dir, "muted.mp4"), "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "-")
	mutedPCM, err := mutedCmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i+3 < len(mutedPCM); i += 4 {
		if math.Abs(float64(math.Float32frombits(binary.LittleEndian.Uint32(mutedPCM[i:])))) > 0.0001 {
			t.Fatal("muted/zero volume audio is audible")
		}
	}
	frame := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-ss", "1.5", "-i", filepath.Join(dir, "output.mp4"), "-frames:v", "1", "-vf", "crop=1920:250:0:830", "-pix_fmt", "rgb24", "-f", "rawvideo", "-")
	pixels, err := frame.Output()
	if err != nil {
		t.Fatal(err)
	}
	white := 0
	for i := 0; i+2 < len(pixels); i += 3 {
		if pixels[i] > 180 && pixels[i+1] > 180 && pixels[i+2] > 180 {
			white++
		}
	}
	if white < 100 {
		t.Fatalf("subtitle not visible: %d white pixels", white)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken.mp4"), []byte("not a video"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Probe(ctx, filepath.Join(dir, "broken.mp4")); err == nil {
		t.Fatal("corrupt input silently became mute")
	}
	if err := os.Remove(filepath.Join(dir, SubtitleFileName)); err != nil {
		t.Fatal(err)
	}
	cmd = exec.CommandContext(ctx, ffmpeg, BuildFFmpegArgs(*plan, files, "failed.mp4")...)
	cmd.Dir = dir
	if err := cmd.Run(); err == nil {
		t.Fatal("missing subtitle accepted")
	}
}

func TestRenderFFmpegShortVideoHoldsLastFrame(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	dir := t.TempDir()
	run := func(args ...string) []byte {
		t.Helper()
		cmd := exec.CommandContext(ctx, ffmpeg, args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("ffmpeg: %v: %s", err, out)
		}
		return out
	}
	for _, color := range []string{"red", "blue"} {
		run("-v", "error", "-y", "-f", "lavfi", "-i", "color=c="+color+":s=320x180:r=30:d=1", "-c:v", "libx264", color+".mp4")
	}
	plan := Plan{
		Output:     Output{Width: DefaultWidth, Height: DefaultHeight, FPS: DefaultFPS, SampleRate: DefaultSampleRate},
		DurationMs: 3000,
		Segments: []Segment{
			{Kind: KindVideo, SourceID: "red", DurationMs: 2000, Volume: 1},
			{Kind: KindVideo, SourceID: "blue", DurationMs: 1000, Volume: 1},
		},
	}
	run(BuildFFmpegArgs(plan, map[string]string{"red": "red.mp4", "blue": "blue.mp4"}, "output.mp4")...)
	cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-i", filepath.Join(dir, "output.mp4"), "-an", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-")
	pixels, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if len(pixels) != 90*3 {
		t.Fatalf("short source changed plan duration: %d frames", len(pixels)/3)
	}
	for i := 0; i < 90; i++ {
		r, b := pixels[i*3], pixels[i*3+2]
		if i < 60 && (r < 180 || b > 40) {
			t.Fatalf("red last frame not held at frame %d", i)
		}
		if i >= 60 && (b < 180 || r > 40) {
			t.Fatalf("blue boundary shifted at frame %d", i)
		}
	}
}

func TestRenderFFmpegGapsSilentVideoAndFades(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg required")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	dir := t.TempDir()
	run := func(args ...string) []byte {
		t.Helper()
		cmd := exec.CommandContext(ctx, ffmpeg, args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("ffmpeg: %v: %s", err, out)
		}
		return out
	}
	run("-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", "tone.mp4")
	run("-v", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=320x180:r=30:d=1", "-an", "-c:v", "libx264", "silent.mp4")
	run("-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=2", "voice.wav")
	tone := clip("tone", KindVideo, "v", 0, 1000, "resource:tone")
	silent := clip("silent", KindVideo, "v", 2000, 1000, "resource:silent")
	voice := clip("voice", KindAudio, "a", 0, 1000, "resource:voice")
	voice.FadeInMs = 800
	project := Project{
		Version:    2,
		DurationMs: 3000,
		Tracks:     []Track{{ID: "v"}, {ID: "a"}},
		Clips:      []Clip{tone, silent, voice},
	}
	plan, err := Compile(project, nil, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Segments) != 3 || plan.Segments[1].Kind != KindGap {
		t.Fatalf("expected tone/gap/silent: %+v", plan.Segments)
	}
	files := map[string]string{"tone": "tone.mp4", "silent": "silent.mp4", "voice": "voice.wav"}
	if err := ApplySourceFacts(plan, map[string]SourceFacts{
		"tone":   {HasVideo: true, HasAudio: true, DurationMs: 1000},
		"silent": {HasVideo: true, HasAudio: false, DurationMs: 1000},
		"voice":  {HasAudio: true, DurationMs: 2000},
	}); err != nil {
		t.Fatal(err)
	}
	if plan.Segments[2].HasAudio {
		t.Fatal("silent video kept a mapped audio stream")
	}
	args := BuildFFmpegArgs(*plan, files, "output.mp4")
	if !strings.Contains(strings.Join(args, " "), "afade=t=in") {
		t.Fatalf("fade missing: %s", args)
	}
	run(args...)
	probe := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filepath.Join(dir, "output.mp4"))
	out, err := probe.Output()
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(parseDuration(t, string(out))-3) > 0.08 {
		t.Fatalf("duration=%s", out)
	}
	pcmCmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-i", filepath.Join(dir, "output.mp4"), "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "-")
	pcm, err := pcmCmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	amp := func(start float64) float64 {
		var sum float64
		n := 4000
		offset := int(start * 44100)
		for i := 0; i < n; i++ {
			sum += math.Abs(float64(math.Float32frombits(binary.LittleEndian.Uint32(pcm[(offset+i)*4:]))))
		}
		return sum / float64(n)
	}
	earlyFade, lateFade, midGap, late := amp(0.02), amp(0.7), amp(1.2), amp(2.2)
	t.Logf("amp fade0=%.5f fade1=%.5f gap=%.5f silent=%.5f", earlyFade, lateFade, midGap, late)
	if earlyFade >= lateFade {
		t.Fatal("audio fade-in did not increase over the first second")
	}
	if midGap > 0.002 {
		t.Fatal("gap was not silent")
	}
	if late > 0.002 {
		t.Fatal("silent video leaked source audio")
	}
	frame := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-ss", "1.2", "-i", filepath.Join(dir, "output.mp4"), "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-")
	pixel, err := frame.Output()
	if err != nil || len(pixel) < 3 {
		t.Fatalf("gap frame: %v %d", err, len(pixel))
	}
	if pixel[0] > 40 || pixel[1] > 40 || pixel[2] > 40 {
		t.Fatalf("gap was not black: %v", pixel[:3])
	}
}

func TestRenderFFmpegImageGapSubtitleTerminates(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg required")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dir := t.TempDir()
	run := func(args ...string) []byte {
		t.Helper()
		cmd := exec.CommandContext(ctx, ffmpeg, args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("ffmpeg: %v: %s", err, out)
		}
		return out
	}
	run("-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180", "-frames:v", "1", "still.png")
	run("-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "voice.wav")
	still := clip("still", KindImage, "v", 0, 2000, "resource:still")
	voice := clip("voice", KindAudio, "a", 0, 2000, "resource:voice")
	project := Project{
		Version:    2,
		DurationMs: 3000,
		Tracks:     []Track{{ID: "v"}, {ID: "a"}, {ID: "s"}},
		Clips: []Clip{
			still, voice,
			{ID: "sub", Kind: KindSubtitle, TrackID: "s", StartMs: 500, DurationMs: 1000, Text: "图片"},
		},
	}
	opts := DefaultOptions()
	opts.Width, opts.Height, opts.FPS = 320, 180, 30
	plan, err := Compile(project, nil, opts)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Segments) != 2 || plan.Segments[0].Kind != KindImage || plan.Segments[1].Kind != KindGap {
		t.Fatalf("segments=%+v", plan.Segments)
	}
	files := map[string]string{"still": "still.png", "voice": "voice.wav"}
	if err := os.WriteFile(filepath.Join(dir, SubtitleFileName), []byte(plan.SubtitleSRT), 0600); err != nil {
		t.Fatal(err)
	}
	args := BuildFFmpegArgs(*plan, files, "output.mp4")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-t 3.000") || strings.Contains(joined, "alimiter") {
		t.Fatalf("image output must be bounded and mix without limiter: %s", joined)
	}
	run(args...)
	probe := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filepath.Join(dir, "output.mp4"))
	out, err := probe.Output()
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(parseDuration(t, string(out))-3) > 0.12 {
		t.Fatalf("duration=%s", out)
	}
	pcmCmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-i", filepath.Join(dir, "output.mp4"), "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "-")
	pcm, err := pcmCmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	amp := func(start float64) float64 {
		var sum float64
		n := 4000
		offset := int(start * 44100)
		for i := 0; i < n; i++ {
			sum += math.Abs(float64(math.Float32frombits(binary.LittleEndian.Uint32(pcm[(offset+i)*4:]))))
		}
		return sum / float64(n)
	}
	if amp(0.5) < 0.01 {
		t.Fatal("image+audio mix lost the voice")
	}
	if amp(2.3) > 0.002 {
		t.Fatal("gap after the still was not silent")
	}
	if ctx.Err() != nil {
		t.Fatal("image export did not finish within timeout")
	}
}

func TestRendererRenderProbesActualOutput(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	dir := t.TempDir()
	src := filepath.Join(dir, "source.mp4")
	cmd := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", src)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	opts := DefaultOptions()
	opts.Width, opts.Height, opts.FPS = 320, 180, 30
	plan, err := Compile(Project{
		Version:    2,
		DurationMs: 1000,
		Tracks:     []Track{{ID: "v"}},
		Clips:      []Clip{clip("v", KindVideo, "v", 0, 1000, "resource:src")},
	}, nil, opts)
	if err != nil {
		t.Fatal(err)
	}
	renderer := &Renderer{Sources: fileSources{"src": src}}
	rendered, cleanup, err := renderer.Render(ctx, plan, nil)
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		t.Fatal(err)
	}
	if rendered.Size == 0 || rendered.Width != 320 {
		t.Fatalf("rendered=%+v", rendered)
	}
	if !outputDurationWithinPlan(plan.DurationMs, rendered.DurationMs, plan.Output.FPS) {
		t.Fatalf("rendered duration %d outside plan %d", rendered.DurationMs, plan.DurationMs)
	}
	facts, err := Probe(ctx, rendered.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !facts.HasVideo || !facts.HasAudio || facts.DurationMs <= 0 {
		t.Fatalf("probe=%+v", facts)
	}
}

func TestRendererRejectsVideoOnlyFakeOutput(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg required")
	}
	src := requireTinyAVSource(t)
	script := fmt.Sprintf(`out=""; for arg in "$@"; do out=$arg; done
%q -v error -y -f lavfi -i color=c=red:s=320x180:r=30:d=1 -an -c:v libx264 "$out"
exit 0`, ffmpeg)
	renderer := &Renderer{FFmpeg: writeFakeFFmpeg(t, script), Sources: fileSources{"src": src}}
	_, cleanup, err := renderer.Render(context.Background(), shortVideoPlan(), nil)
	if cleanup != nil {
		cleanup()
	}
	if err == nil || !strings.Contains(err.Error(), "音频轨") {
		t.Fatalf("err=%v, want missing audio rejected", err)
	}
}

func TestRendererRejectsDurationMismatchFakeOutput(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg required")
	}
	src := requireTinyAVSource(t)
	script := fmt.Sprintf(`out=""; for arg in "$@"; do out=$arg; done
%q -v error -y -f lavfi -i color=c=red:s=320x180:r=30:d=3 -f lavfi -i sine=frequency=440:duration=3 -c:v libx264 -c:a aac "$out"
exit 0`, ffmpeg)
	plan := shortVideoPlan()
	renderer := &Renderer{FFmpeg: writeFakeFFmpeg(t, script), Sources: fileSources{"src": src}}
	_, cleanup, err := renderer.Render(context.Background(), plan, nil)
	if cleanup != nil {
		cleanup()
	}
	if err == nil || !strings.Contains(err.Error(), "时长") {
		t.Fatalf("err=%v, want duration mismatch rejected", err)
	}
}

func parseDuration(t *testing.T, raw string) float64 {
	t.Helper()
	var value float64
	if _, err := fmt.Sscanf(strings.TrimSpace(raw), "%f", &value); err != nil {
		t.Fatal(err)
	}
	return value
}
