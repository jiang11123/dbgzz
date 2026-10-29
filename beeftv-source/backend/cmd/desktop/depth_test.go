package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/depthruntime"
)

func TestDepthStatusAllowsSlowMetadataWithoutBlockingWorkspaceLock(t *testing.T) {
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Skip("native MPS component status; mirror trust is covered in depthruntime")
	}
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-time.After(9 * time.Second):
		case <-r.Context().Done():
			return
		}
		json.NewEncoder(w).Encode(depthruntime.Manifest{Version: 1, Runtime: depthruntime.Artifact{Size: 3, SHA256: strings.Repeat("a", 64), ExpandedSize: 4}, Model: depthruntime.Artifact{Size: 5, SHA256: strings.Repeat("b", 64)}})
	}))
	defer server.Close()
	t.Setenv("BEEFTV_DEPTH_MANIFEST_URL", server.URL)
	app := newDesktopApp(t.TempDir())
	if err := app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer app.stop(context.Background())
	done := make(chan error, 1)
	go func() {
		state, err := app.DepthComponentStatus(true)
		if err == nil && state.DownloadBytes != 8 {
			t.Errorf("plan bytes = %d", state.DownloadBytes)
		}
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("metadata request not started")
	}
	available := app.mu.TryLock()
	if available {
		app.mu.Unlock()
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("metadata request did not complete")
	}
	if !available {
		t.Fatal("metadata fetch held the workspace lock")
	}
}
