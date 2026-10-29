package generation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type videoTestCache string

func (p videoTestCache) PartialPath() string { return string(p) }

func TestVideoDownloadResumeRetainsAdmissionAndFailureReceipt(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "65536")
		_, _ = w.Write(bytes.Repeat([]byte("v"), 1024))
		w.(http.Flusher).Flush()
	}))
	defer server.Close()
	limits, receipts, progress := &deliveryCircuitLimits{}, &recordingReceipts{}, &fakeDeliveryPort{}
	ctx := WithRuntime(context.Background(), Runtime{
		Limits: limits, Receipts: receipts, Delivery: progress,
		Call: CallMeta{ChannelID: "video", RequestKind: "download"},
	})
	_, _, err := RunVideoDownload(ctx, "original", fastPolicy(1, SleepContext), downloadFrom(server.URL))
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("short read error = %v", err)
	}
	if limits.checks != 0 || limits.results != 0 || limits.acquired != 1 || limits.released != 1 {
		t.Fatalf("download admission = %+v", limits)
	}
	observed := receipts.snapshot()
	if len(observed) != 1 || observed[0].ReceivedBytes != 1024 || !errors.Is(observed[0].Err, io.ErrUnexpectedEOF) {
		t.Fatalf("missing partial read evidence: %+v", observed)
	}
	runtime, _ := RuntimeFromContext(observed[0].Request.Context())
	if runtime.Call.ConcurrencyLimit != 1 {
		t.Fatal("missing admission limit in receipt")
	}
	reports := progress.snapshot()
	last := reports[len(reports)-1]
	if last.DownloadedBytes != 1024 || last.TotalBytes != 65536 {
		t.Fatalf("short read lost progress: %+v", last)
	}
}

func TestVideoDownloadResumesAcrossWorkerAndSignedRedirect(t *testing.T) {
	payload := bytes.Repeat([]byte("video data\x00"), 32<<10)
	partial := filepath.Join(t.TempDir(), "video.part")
	var offsets []int
	complete := false
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Secret") != "" {
			t.Error("gateway credential leaked")
		}
		start := 0
		if value := r.Header.Get("Range"); value != "" {
			start, _ = strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(value, "bytes="), "-"))
			if r.Header.Get("If-Range") != `"v1"` {
				t.Error("missing strong validator")
			}
		}
		offsets = append(offsets, start)
		w.Header().Set("ETag", `"v1"`)
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)-start))
		if start > 0 {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(payload)-1, len(payload)))
			w.WriteHeader(206)
		}
		data := payload[start:]
		if !complete {
			data = data[:16<<10]
		}
		_, _ = w.Write(data)
		w.(http.Flusher).Flush()
	}))
	defer media.Close()
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Fatal("result recovery submitted generation")
		}
		http.Redirect(w, r, media.URL+"/original.mp4?signature=changed", 302)
	}))
	defer gateway.Close()
	config := Config{BaseURL: gateway.URL + "/v1", APIKey: "test-key"}
	ctx := WithRuntime(context.Background(), Runtime{DownloadCache: videoTestCache(partial), Endpoints: Endpoints{BeefAPIVideoBaseURL: config.BaseURL}})
	policy := DefaultVideoPollPolicy()
	policy.MaxDownloadTries = 1
	policy.Sleep = func(context.Context, time.Duration) error { return nil }
	_, _, err := RunVideoDownload(ctx, "original", policy, videoResultDownloader(config, gateway.URL+"/v1/videos/original/content?signature=old", "original"))
	if err == nil {
		t.Fatal("incomplete response succeeded")
	}
	info, err := os.Stat(partial)
	if err != nil || info.Size() != 32<<10 {
		t.Fatalf("partial not retained: info=%v err=%v", info, err)
	}
	sidecar, _ := os.ReadFile(partial + ".json")
	if bytes.Contains(sidecar, []byte("signature=")) {
		t.Fatal("signed query persisted")
	}
	complete = true
	data, _, err := RunVideoDownload(ctx, "original", policy, videoResultDownloader(config, gateway.URL+"/v1/videos/original/content?signature=new", "original"))
	if err != nil || !bytes.Equal(data, payload) {
		t.Fatalf("resume failed: len=%d err=%v", len(data), err)
	}
	if len(offsets) != 3 || offsets[0] != 0 || offsets[1] != 16<<10 || offsets[2] != 32<<10 {
		t.Fatalf("did not resume across redirect and worker: %v", offsets)
	}
	if _, err = os.Stat(partial); !os.IsNotExist(err) {
		t.Fatal("completed partial not cleaned")
	}
}

func TestVideoDownloadResumesThroughHTTPProxy(t *testing.T) {
	payload := bytes.Repeat([]byte("proxied-video"), 4096)
	requests := 0
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		start := 0
		if value := r.Header.Get("Range"); value != "" {
			start, _ = strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(value, "bytes="), "-"))
		}
		w.Header().Set("ETag", `"proxy-v1"`)
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)-start))
		if start > 0 {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(payload)-1, len(payload)))
			w.WriteHeader(206)
		}
		if requests == 1 {
			_, _ = w.Write(payload[:8192])
			w.(http.Flusher).Flush()
			return
		}
		if start != 8192 {
			t.Errorf("proxy retry started at %d", start)
		}
		_, _ = w.Write(payload[start:])
	}))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("http_proxy", proxy.URL)
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")
	policy := DefaultVideoPollPolicy()
	policy.Sleep = func(context.Context, time.Duration) error { return nil }
	data, _, err := RunVideoDownload(context.Background(), "original", policy, videoResultDownloader(Config{}, "http://1.1.1.1/video.mp4", "original"))
	if err != nil || !bytes.Equal(data, payload) || requests != 2 {
		t.Fatalf("proxied resume requests=%d bytes=%d err=%v", requests, len(data), err)
	}
}
