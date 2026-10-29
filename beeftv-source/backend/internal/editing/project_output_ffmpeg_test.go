package editing

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestSavedPortraitProjectRendersPortraitAfterSubtitleEdit(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg required")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe required")
	}
	dir := t.TempDir()
	cmd := exec.Command(ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=180x320:r=24:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", "source.mp4")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	var project Project
	if err := json.Unmarshal([]byte(`{"version":2,"output":{"width":180,"height":320,"fps":24},"durationMs":1000,"tracks":[{"id":"shots","kind":"video"},{"id":"captions","kind":"subtitle"}],"clips":[{"id":"v","kind":"video","trackId":"shots","startMs":0,"durationMs":1000,"directMedia":{"storageKey":"resource:source"}},{"id":"s","kind":"subtitle","trackId":"captions","startMs":0,"durationMs":1000,"text":"旧字幕"}]}`), &project); err != nil {
		t.Fatal(err)
	}
	project.Clips[1].Text = "新字幕，继续翻开"
	saved, _ := json.Marshal(project)
	if err := json.Unmarshal(saved, &project); err != nil {
		t.Fatal(err)
	}
	plan, err := Compile(project, nil, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, SubtitleFileName), []byte(plan.SubtitleSRT), 0600); err != nil {
		t.Fatal(err)
	}
	cmd = exec.Command(ffmpeg, BuildFFmpegArgs(*plan, map[string]string{"source": "source.mp4"}, "output.mp4")...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil || SubtitleFontFailure(string(out)) {
		t.Fatalf("render: %v %s", err, out)
	}
	out, err := exec.Command(ffprobe, "-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", filepath.Join(dir, "output.mp4")).Output()
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Streams []struct {
			Type          string `json:"codec_type"`
			Width, Height int
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatal(err)
	}
	video, audio := false, false
	for _, stream := range result.Streams {
		if stream.Type == "video" {
			video = stream.Width == 180 && stream.Height == 320
		}
		if stream.Type == "audio" {
			audio = true
		}
	}
	if !video || !audio {
		t.Fatalf("portrait/audio lost: %s", out)
	}
	if out, err := exec.Command(ffmpeg, "-v", "error", "-i", filepath.Join(dir, "output.mp4"), "-f", "null", "-").CombinedOutput(); err != nil {
		t.Fatalf("decode: %v %s", err, out)
	}
}
