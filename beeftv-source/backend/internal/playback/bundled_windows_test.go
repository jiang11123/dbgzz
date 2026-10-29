package playback

import (
	"context"
	"crypto/sha256"
	"infinite-canvas/backend/internal/mediatools"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// Runs under a relocated test executable beside the actual packaged runtime.
// The caller supplies only that test process a PATH with no ffmpeg executable.
func TestBundledWindowsHEVCWithoutSystemFFmpeg(t *testing.T) {
	if runtime.GOOS != "windows" || os.Getenv("BEEFTV_TEST_BUNDLED_MEDIA") != "1" {
		t.Skip("native packaged Windows acceptance")
	}
	if path, err := exec.LookPath("ffmpeg"); err == nil {
		t.Fatalf("global FFmpeg leaked into acceptance: %s", path)
	}
	binary, err := mediatools.ResolveFFmpeg()
	if err != nil || filepath.Base(filepath.Dir(binary)) != "media-runtime" {
		t.Fatalf("bundle not used: %s %v", binary, err)
	}
	src, dst := filepath.Join(t.TempDir(), "源视频.mp4"), filepath.Join(t.TempDir(), "预览.mp4")
	cmd := exec.Command(binary, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=5:d=0.4", "-c:v", "libx265", "-x265-params", "pools=1:frame-threads=1", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", src)
	mediatools.HideConsole(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("HEVC fixture: %s %v", out, err)
	}
	original, _ := os.ReadFile(src)
	if ProbeCodec(src) != CodecH265 {
		t.Fatal("fixture is not HEVC")
	}
	if err := runH264Transcode(context.Background(), src, dst); err != nil {
		t.Fatal(err)
	}
	if ProbeCodec(dst) != CodecH264 {
		t.Fatal("preview is not H.264")
	}
	if path, err := exec.LookPath("ffprobe"); err == nil {
		t.Fatalf("global FFprobe leaked into acceptance: %s", path)
	}
	facts, err := mediatools.ProbeLocal(context.Background(), dst)
	if err != nil || facts.Width != 64 || facts.Height != 48 || facts.DurationMs <= 0 {
		t.Fatalf("bundled FFprobe: %+v %v", facts, err)
	}
	after, _ := os.ReadFile(src)
	if sha256.Sum256(original) != sha256.Sum256(after) {
		t.Fatal("original modified")
	}
	t.Logf("no-PATH HEVC → H.264 succeeded using %s", binary)
}
