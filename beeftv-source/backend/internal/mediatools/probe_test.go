package mediatools

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

func TestProbeLocalNativeAndFailures(t *testing.T) {
	ffmpeg, err := ResolveFFmpeg()
	if err != nil {
		t.Skip(err)
	}
	if _, err := ResolveFFprobe(); err != nil {
		t.Skip(err)
	}
	path := filepath.Join(t.TempDir(), "中文 media.mp4")
	cmd := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=5:d=0.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", path)
	HideConsole(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("native fixture: %s %v", out, err)
	}
	facts, err := ProbeLocal(context.Background(), path)
	if err != nil || facts.Width != 64 || facts.Height != 48 || facts.DurationMs != 400 || !facts.HasVideo {
		t.Fatalf("facts = %+v, %v", facts, err)
	}
	t.Setenv(FFprobePathEnv, filepath.Join(t.TempDir(), "missing-probe"))
	if _, err := ProbeLocal(context.Background(), path); err == nil {
		t.Fatal("missing explicit tool fell back")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ProbeLocal(ctx, path); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel = %v", err)
	}
	if _, err := ProbeLocal(context.Background(), "https://example.com/file.mp4"); err == nil {
		t.Fatal("remote URL accepted")
	}
}

func TestProbeLocalStopsTimedOutProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell timeout fixture; native bundle tested separately")
	}
	dir := t.TempDir()
	tool := filepath.Join(dir, "ffprobe")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\nexec sleep 10\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "media")
	if err := os.WriteFile(file, []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(FFprobePathEnv, tool)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := ProbeLocal(ctx, file); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout = %v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("probe process survived timeout")
	}
}

func TestAlreadyCanceledProbeDoesNotStartProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell process marker fixture")
	}
	dir := t.TempDir()
	tool := filepath.Join(dir, "ffprobe")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\nprintf started > \"$0.started\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "media")
	if err := os.WriteFile(file, []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(FFprobePathEnv, tool)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ProbeLocal(ctx, file); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := os.Stat(tool + ".started"); !os.IsNotExist(err) {
		t.Fatal("canceled probe started its process")
	}
}

func TestBundledFFprobeRelocation(t *testing.T) {
	root := filepath.Join(t.TempDir(), "中文 install")
	want := filepath.Join(root, "agent-host", "media-runtime", "ffprobe.exe")
	if err := os.MkdirAll(filepath.Dir(want), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(want, []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, executable := range []string{filepath.Join(root, "BeefTV.exe"), filepath.Join(root, "cli", "beeftv.exe")} {
		if got := bundledTool(executable, "ffprobe"); got != want {
			t.Fatalf("got %s want %s", got, want)
		}
	}
}

func TestBundledDarwinFFprobeRelocationAndCLI(t *testing.T) {
	contents := filepath.Join(t.TempDir(), "中文 bundle", "Contents")
	want := filepath.Join(contents, "Resources", "agent-host", "media-runtime", "ffprobe")
	if err := os.MkdirAll(filepath.Dir(want), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(want, []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, executable := range []string{filepath.Join(contents, "MacOS", "BeefTV"), filepath.Join(contents, "MacOS", "cli", "beeftv")} {
		if got := bundledTool(executable, "ffprobe"); got != want {
			t.Fatalf("got %s want %s", got, want)
		}
	}
}

func TestProbeLocalDoesNotFetchPlaylistURLs(t *testing.T) {
	if _, err := ResolveFFprobe(); err != nil {
		t.Skip(err)
	}
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer server.Close()
	file := filepath.Join(t.TempDir(), "playlist.m3u8")
	playlist := "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n" + server.URL + "/secret.ts\n#EXT-X-ENDLIST\n"
	if err := os.WriteFile(file, []byte(playlist), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ProbeLocal(context.Background(), file); err == nil {
		t.Fatal("remote playlist accepted")
	}
	if hits.Load() != 0 {
		t.Fatal("media probe issued a network request")
	}
}
