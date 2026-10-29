package playback

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestNativeHEVCPlaybackPreservesOriginal(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("native ffmpeg not installed")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "resources", "original.mp4")
	if err := os.MkdirAll(filepath.Dir(src), 0o750); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=5:d=0.4", "-c:v", "libx265", "-x265-params", "pools=1:frame-threads=1", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", src)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create HEVC: %v: %s", err, output)
	}
	original, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if ProbeCodec(src) != CodecH265 {
		t.Fatal("fixture is not HEVC")
	}
	resource := model.Resource{ID: "native-hevc", UserID: "user-1", Kind: "video", Provider: "local", Status: model.ResourceStatusReady, ObjectKey: "original.mp4"}
	store := &memStore{}
	store.put(resource)
	service := New(Deps{DataDir: dir, Store: store, Runner: ctxRunner{ctx: ctx}})
	service.MaybeStart(&resource)
	saved, _ := store.ResourceForUser("user-1", resource.ID)
	if saved.PlaybackStatus != model.PlaybackStatusReady {
		t.Fatalf("playback = %s: %s", saved.PlaybackStatus, saved.PlaybackError)
	}
	if ProbeCodec(filepath.Join(dir, DirName, saved.PlaybackObjectKey)) != CodecH264 {
		t.Fatal("copy is not H264")
	}
	after, err := os.ReadFile(src)
	if err != nil || !bytes.Equal(original, after) {
		t.Fatal("original HEVC changed")
	}
	stream, err := service.OpenRange("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	stream.Body.Close()
}
