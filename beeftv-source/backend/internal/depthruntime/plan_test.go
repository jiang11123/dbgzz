package depthruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestMetadataAndSpaceCheckNeverDownloadArtifacts(t *testing.T) {
	var artifacts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/manifest" {
			artifacts.Add(1)
			http.Error(w, "unexpected artifact", 500)
			return
		}
		_ = json.NewEncoder(w).Encode(Manifest{Version: 1, Runtime: Artifact{URLs: []string{"/runtime"}, Size: 100, SHA256: strings.Repeat("0", 64), ExpandedSize: 1 << 50}, Model: Artifact{URLs: []string{"/model"}, Size: 100, SHA256: strings.Repeat("0", 64)}})
	}))
	defer server.Close()
	opts := EnsureOptions{DataDir: t.TempDir(), ManifestURL: server.URL + "/manifest", Platform: "darwin-arm64", Variant: "mps"}
	plan, err := DownloadPlan(context.Background(), opts)
	if err != nil || plan.DownloadBytes != 200 || plan.RequiredBytes <= int64(plan.FreeBytes) {
		t.Fatalf("plan=%+v err=%v", plan, err)
	}
	_, err = Ensure(context.Background(), opts)
	if err == nil || !strings.Contains(err.Error(), "磁盘空间不足") || artifacts.Load() != 0 {
		t.Fatalf("artifacts=%d err=%v", artifacts.Load(), err)
	}
	opts.ApprovedPlan = &Plan{DownloadBytes: 1, RequiredBytes: 1}
	_, err = Ensure(context.Background(), opts)
	if err == nil || !strings.Contains(err.Error(), "信息已变化") || artifacts.Load() != 0 {
		t.Fatalf("changed download exceeded consent: %v", err)
	}
	opts.Offline = true
	_, err = Ensure(context.Background(), opts)
	if err != ErrNotInstalled {
		t.Fatalf("offline=%v", err)
	}
}
