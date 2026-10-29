package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func TestFailedVideoManualRecoveryResumesProviderDownloadCache(t *testing.T) {
	allowLoopbackProviderTest(t)
	payload, err := os.ReadFile("testdata/reference-fragmented-30fps.mp4")
	if err != nil {
		t.Fatal(err)
	}
	var downloads, creates, polls atomic.Int32
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := downloads.Add(1)
		start := 0
		if call > 1 {
			if r.Header.Get("Range") != "bytes=1024-" || r.Header.Get("If-Range") != `"original-v1"` {
				t.Errorf("manual recovery lost partial: Range=%q If-Range=%q", r.Header.Get("Range"), r.Header.Get("If-Range"))
			}
			start = 1024
		}
		w.Header().Set("ETag", `"original-v1"`)
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)-start))
		if start > 0 {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(payload)-1, len(payload)))
			w.WriteHeader(http.StatusPartialContent)
		}
		data := payload[start:]
		if call == 1 {
			data = data[:1024]
		}
		_, _ = w.Write(data)
		w.(http.Flusher).Flush()
	}))
	defer media.Close()
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			creates.Add(1)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Path != "/v1/videos/original" {
			t.Errorf("unexpected recovery route: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		polls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "completed", "metadata": map[string]any{"url": media.URL + "/video.mp4?signature=renewed"}})
	}))
	defer gateway.Close()
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	inputJSON, err := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{
		BaseURL: gateway.URL, APIKey: "test-key", Model: "unlisted-future-video", InterfaceType: "newapi",
	}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := model.Task{ID: "provider-resume", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed,
		ProviderRequestID: "original", InputJSON: string(inputJSON), CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: gateway.URL})
	_, _, err = generation.RunVideoDownload(withProviderAnalytics(ctx, svc, task), "original", generation.VideoPollPolicy{
		Interval: time.Millisecond, MaxDownloadTries: 1, Sleep: generation.SleepContext,
	}, func(ctx context.Context) ([]byte, string, error) {
		return generation.GetExternalBinary(ctx, media.URL+"/video.mp4?signature=old")
	})
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("initial download did not retain partial: %v", err)
	}
	partial := (appTaskDownloadCachePort{service: svc, userID: task.UserID, taskID: task.ID}).PartialPath()
	if info, err := os.Stat(partial); err != nil || info.Size() != 1024 {
		t.Fatalf("missing provider partial: info=%v err=%v", info, err)
	}
	// The public manual-recovery entry point binds its own runtime and cache.
	// Only the original task identity connects it to the interrupted download.
	recovered, err := svc.QueryFailedVideoTask(ctx, task.UserID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !recovered.Recovered || recovered.Task.ID != task.ID || recovered.Task.ProviderRequestID != "original" || recovered.Task.ResultState != "READY" || creates.Load() != 0 || polls.Load() != 1 || downloads.Load() != 2 {
		t.Fatalf("recovered=%+v creates=%d polls=%d downloads=%d", recovered, creates.Load(), polls.Load(), downloads.Load())
	}
	var resources []model.Resource
	if err := db.Find(&resources).Error; err != nil || len(resources) != 1 {
		t.Fatalf("resources=%d err=%v", len(resources), err)
	}
	data, err := os.ReadFile(filepath.Join(svc.dataDir, "resources", filepath.FromSlash(resources[0].ObjectKey)))
	if err != nil || !bytes.Equal(data, payload) {
		t.Fatalf("recovered media differs: bytes=%d err=%v", len(data), err)
	}
	for _, path := range []string{partial, partial + ".json"} {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("partial remains after success: %s err=%v", path, err)
		}
	}
}
