package desktopupdate

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestEngineDisabledKeepsCurrentVersion(t *testing.T) {
	engine := NewWithOptions(Options{CurrentVersion: "v1.5.1"})
	state := engine.Status()
	if state.Status != StatusDisabled || state.CurrentVersion != "v1.5.1" {
		t.Fatalf("%+v", state)
	}
	state, err := engine.CheckForUpdate(context.Background())
	if !errors.Is(err, ErrDisabled) {
		t.Fatalf("err = %v", err)
	}
	if state.Status != StatusDisabled || state.CurrentVersion != "v1.5.1" {
		t.Fatalf("%+v", state)
	}
}

func TestCheckDownloadInstallHappyPath(t *testing.T) {
	pub, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	files, execFiles := DarwinZipFiles("NEW")
	zipPath := filepath.Join(t.TempDir(), "app.zip")
	if err := WriteZip(zipPath, files, execFiles); err != nil {
		t.Fatal(err)
	}
	zipBytes, err := os.ReadFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(zipBytes)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest":
			http.Redirect(w, r, "/desktop-update.json", http.StatusFound)
		case "/desktop-update.json":
			payload := testPayload("v1.6.0", "darwin-arm64", "https://example.invalid/placeholder", hex.EncodeToString(sum[:]), int64(len(zipBytes)), "新版本说明")
			payload.Platforms["darwin-arm64"] = PlatformArtifact{
				URL:    "https://" + r.Host + "/BeefTV.zip",
				SHA256: hex.EncodeToString(sum[:]),
				Size:   int64(len(zipBytes)),
			}
			body, err := SignEnvelope(priv, payload)
			if err != nil {
				t.Error(err)
				http.Error(w, "sign", 500)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(body)
		case "/BeefTV.zip":
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write(zipBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	oldRoot := t.TempDir()
	if err := WriteDarwinLayout(oldRoot, "OLD"); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(oldRoot, "keep.txt")
	if err := os.WriteFile(keep, []byte("stay"), 0o644); err != nil {
		t.Fatal(err)
	}
	userData := filepath.Join(t.TempDir(), "userdata", "plugin-packages")
	if err := os.MkdirAll(userData, 0o700); err != nil {
		t.Fatal(err)
	}
	customPlugin := filepath.Join(userData, "custom.beeftv-plugin")
	if err := os.WriteFile(customPlugin, []byte("user-plugin"), 0o600); err != nil {
		t.Fatal(err)
	}

	var quit bool
	engine := NewWithOptions(Options{
		CurrentVersion: "v1.5.1",
		FeedURL:        server.URL + "/latest",
		PublicKey:      pub,
		Platform:       "darwin-arm64",
		Client:         server.Client(),
		StagingRoot:    t.TempDir(),
		ParentPID:      unusedPID(t),
		Locate: func() (Target, error) {
			return Target{Platform: "darwin-arm64", Kind: "app", Path: filepath.Join(oldRoot, appBundleName)}, nil
		},
		Helper: RunHelperRequest,
		Quit: func() error {
			quit = true
			return nil
		},
	})
	relaunchInstall = func(HelperRequest) error { return nil }
	t.Cleanup(func() { relaunchInstall = relaunchTarget })

	state, err := engine.CheckForUpdate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != StatusAvailable || state.LatestVersion != "v1.6.0" || state.ReleaseNotes != "新版本说明" {
		t.Fatalf("%+v", state)
	}
	state, err = engine.DownloadUpdate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != StatusReady || state.DownloadedBytes != state.TotalBytes || state.TotalBytes == 0 {
		t.Fatalf("%+v", state)
	}
	entries, err := os.ReadDir(filepath.Dir(engine.staged.archive))
	if err != nil || len(entries) != 1 || entries[0].Name() != "update.zip" {
		t.Fatalf("download must keep only archive, without redundant extraction: %v %v", entries, err)
	}
	if err := engine.InstallUpdate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !quit {
		t.Fatal("expected orderly quit after helper prepared")
	}
	time.Sleep(50 * time.Millisecond)
	got, err := os.ReadFile(filepath.Join(oldRoot, appBundleName, "Contents", "MacOS", "BeefTV"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "NEW") {
		t.Fatalf("installed = %q", got)
	}
	kept, err := os.ReadFile(keep)
	if err != nil || string(kept) != "stay" {
		t.Fatalf("keep.txt = %q err=%v", kept, err)
	}
	custom, err := os.ReadFile(customPlugin)
	if err != nil || string(custom) != "user-plugin" {
		t.Fatalf("custom plugin = %q err=%v", custom, err)
	}
}

func TestCheckRejectsDowngradeEqualWrongPlatformTimeoutAndHash(t *testing.T) {
	pub, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	files, execFiles := DarwinZipFiles("X")
	zipPath := filepath.Join(t.TempDir(), "app.zip")
	if err := WriteZip(zipPath, files, execFiles); err != nil {
		t.Fatal(err)
	}
	zipBytes, _ := os.ReadFile(zipPath)
	sum := sha256.Sum256(zipBytes)

	t.Run("equal", func(t *testing.T) {
		server := signedFeedServer(t, priv, testPayload("v1.5.1", "darwin-arm64", "", hex.EncodeToString(sum[:]), int64(len(zipBytes)), ""), zipBytes)
		engine := testEngine(t, pub, server, "v1.5.1", "darwin-arm64")
		state, err := engine.CheckForUpdate(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if state.Status != StatusIdle || state.LatestVersion != "v1.5.1" {
			t.Fatalf("%+v", state)
		}
	})

	t.Run("downgrade", func(t *testing.T) {
		server := signedFeedServer(t, priv, testPayload("v1.4.0", "darwin-arm64", "", hex.EncodeToString(sum[:]), int64(len(zipBytes)), ""), zipBytes)
		engine := testEngine(t, pub, server, "v1.5.1", "darwin-arm64")
		_, err := engine.CheckForUpdate(context.Background())
		if !errors.Is(err, ErrNoDowngrade) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("wrong-platform", func(t *testing.T) {
		server := signedFeedServer(t, priv, testPayload("v1.6.0", "windows-amd64", "", hex.EncodeToString(sum[:]), int64(len(zipBytes)), ""), zipBytes)
		engine := testEngine(t, pub, server, "v1.5.1", "darwin-arm64")
		_, err := engine.CheckForUpdate(context.Background())
		if !errors.Is(err, ErrWrongPlatform) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
		}))
		t.Cleanup(server.Close)
		engine := NewWithOptions(Options{
			CurrentVersion: "v1.5.1",
			FeedURL:        server.URL + "/desktop-update.json",
			PublicKey:      pub,
			Platform:       "darwin-arm64",
			Client:         server.Client(),
			FeedTimeout:    200 * time.Millisecond,
			RetryBackoff:   func(int) time.Duration { return time.Millisecond },
		})
		_, err := engine.CheckForUpdate(context.Background())
		if !errors.Is(err, ErrTimeout) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("hash", func(t *testing.T) {
		payload := testPayload("v1.6.0", "darwin-arm64", "", strings.Repeat("0", 64), int64(len(zipBytes)), "")
		server := signedFeedServer(t, priv, payload, zipBytes)
		engine := testEngine(t, pub, server, "v1.5.1", "darwin-arm64")
		if _, err := engine.CheckForUpdate(context.Background()); err != nil {
			t.Fatal(err)
		}
		_, err := engine.DownloadUpdate(context.Background())
		if !errors.Is(err, ErrTampered) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("size", func(t *testing.T) {
		payload := testPayload("v1.6.0", "darwin-arm64", "", hex.EncodeToString(sum[:]), int64(len(zipBytes))+9, "")
		server := signedFeedServer(t, priv, payload, zipBytes)
		engine := testEngine(t, pub, server, "v1.5.1", "darwin-arm64")
		if _, err := engine.CheckForUpdate(context.Background()); err != nil {
			t.Fatal(err)
		}
		_, err := engine.DownloadUpdate(context.Background())
		if !errors.Is(err, ErrTampered) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestConcurrentCallsRejectedAndStatusReadableDuringDownload(t *testing.T) {
	pub, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	files, execFiles := DarwinZipFiles("NEW")
	files["BeefTV.app/Contents/Resources/padding.bin"] = []byte(strings.Repeat("p", 8*1024))
	zipPath := filepath.Join(t.TempDir(), "app.zip")
	if err := WriteZip(zipPath, files, execFiles); err != nil {
		t.Fatal(err)
	}
	zipBytes, _ := os.ReadFile(zipPath)
	sum := sha256.Sum256(zipBytes)
	started := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/desktop-update.json" {
			select {
			case <-started:
			default:
				close(started)
			}
			time.Sleep(400 * time.Millisecond)
			payload := testPayload("v1.6.0", "darwin-arm64", "", hex.EncodeToString(sum[:]), int64(len(zipBytes)), "")
			body, _ := SignEnvelope(priv, rewriteArtifactURL(payload, r.Host, zipBytes, sum[:]))
			_, _ = w.Write(body)
			return
		}
		if r.URL.Path == "/BeefTV.zip" {
			flusher, _ := w.(http.Flusher)
			for i := 0; i < len(zipBytes); i += 1024 {
				end := i + 1024
				if end > len(zipBytes) {
					end = len(zipBytes)
				}
				_, _ = w.Write(zipBytes[i:end])
				if flusher != nil {
					flusher.Flush()
				}
				time.Sleep(20 * time.Millisecond)
			}
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	engine := testEngine(t, pub, server, "v1.5.1", "darwin-arm64")

	var firstErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, firstErr = engine.CheckForUpdate(context.Background())
	}()
	<-started
	_, busyErr := engine.CheckForUpdate(context.Background())
	if !errors.Is(busyErr, ErrBusy) {
		t.Fatalf("busy = %v", busyErr)
	}
	status := engine.Status()
	if status.Status != StatusChecking && status.Status != StatusAvailable {
		t.Fatalf("status during check = %+v", status)
	}
	wg.Wait()
	if firstErr != nil {
		t.Fatal(firstErr)
	}

	done := make(chan error, 1)
	go func() { _, err := engine.DownloadUpdate(context.Background()); done <- err }()
	deadline := time.Now().Add(3 * time.Second)
	sawProgress := false
	for time.Now().Before(deadline) {
		state := engine.Status()
		if state.Status == StatusDownloading && state.DownloadedBytes > 0 {
			sawProgress = true
			err := engine.InstallUpdate(context.Background())
			if !errors.Is(err, ErrBusy) {
				t.Fatalf("install during download = %v", err)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !sawProgress {
		t.Fatal("expected download progress while polling UpdateStatus")
	}
}

func signedFeedServer(t *testing.T, priv ed25519.PrivateKey, payload Payload, zipBytes []byte) *httptest.Server {
	t.Helper()
	sum := sha256.Sum256(zipBytes)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/desktop-update.json":
			body, err := SignEnvelope(priv, rewriteArtifactURL(payload, r.Host, zipBytes, sum[:]))
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			_, _ = w.Write(body)
		case "/BeefTV.zip":
			w.Header().Set("Content-Length", strconv.Itoa(len(zipBytes)))
			_, _ = w.Write(zipBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func rewriteArtifactURL(payload Payload, host string, zipBytes []byte, sum []byte) Payload {
	for name, artifact := range payload.Platforms {
		size := artifact.Size
		if size == 0 {
			size = int64(len(zipBytes))
		}
		hash := artifact.SHA256
		if hash == "" {
			hash = hex.EncodeToString(sum)
		}
		artifact.URL = "https://" + host + "/BeefTV.zip"
		artifact.SHA256 = hash
		artifact.Size = size
		payload.Platforms[name] = artifact
	}
	return payload
}

func testEngine(t *testing.T, pub string, server *httptest.Server, current, platform string) *Engine {
	t.Helper()
	return NewWithOptions(Options{
		CurrentVersion: current,
		FeedURL:        server.URL + "/desktop-update.json",
		PublicKey:      pub,
		Platform:       platform,
		Client:         server.Client(),
		StagingRoot:    t.TempDir(),
	})
}
