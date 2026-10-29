package generation

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestVideoDownloadRestartsAfterRangeRejected(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := bytes.Repeat([]byte("video data"), 4096)
	partial := filepath.Join(t.TempDir(), "video.part")
	var ranges []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ranges = append(ranges, r.Header.Get("Range"))
		if len(ranges) == 2 {
			http.Error(w, "Range is not supported", http.StatusBadRequest)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		data := payload
		if len(ranges) == 1 {
			data = data[:1024]
		}
		_, _ = w.Write(data)
		w.(http.Flusher).Flush()
	}))
	defer server.Close()
	ctx := WithRuntime(context.Background(), Runtime{DownloadCache: videoTestCache(partial)})
	_, _, err := RunVideoDownload(ctx, "original", fastPolicy(1, SleepContext), downloadFrom(server.URL))
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("initial short read = %v", err)
	}
	data, _, err := RunVideoDownload(ctx, "original", fastPolicy(2, SleepContext), downloadFrom(server.URL))
	if err != nil || !bytes.Equal(data, payload) {
		t.Fatalf("restart: bytes=%d err=%v", len(data), err)
	}
	if len(ranges) != 3 || ranges[0] != "" || ranges[1] != "bytes=1024-" || ranges[2] != "" {
		t.Fatalf("requests did not reset rejected Range: %q", ranges)
	}
	for _, name := range []string{partial, partial + ".json"} {
		if _, err := os.Stat(name); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("partial not cleared: %s err=%v", name, err)
		}
	}
}

func TestVideoDownloadKeepsPartialAfterAuthenticationAndTemporaryErrors(t *testing.T) {
	for _, status := range []int{401, 403, 408, 409, 425, 429, 503} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
			partial := filepath.Join(t.TempDir(), "video.part")
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if calls == 1 {
					w.Header().Set("ETag", `"v1"`)
					w.Header().Set("Content-Length", "65536")
					_, _ = w.Write(bytes.Repeat([]byte("v"), 1024))
					w.(http.Flusher).Flush()
					return
				}
				if r.Header.Get("Range") != "bytes=1024-" {
					t.Errorf("missing resume offset: %q", r.Header.Get("Range"))
				}
				w.WriteHeader(status)
			}))
			defer server.Close()
			ctx := WithRuntime(context.Background(), Runtime{DownloadCache: videoTestCache(partial)})
			_, _, _ = RunVideoDownload(ctx, "original", fastPolicy(1, SleepContext), downloadFrom(server.URL))
			_, _, err := RunVideoDownload(ctx, "original", fastPolicy(1, SleepContext), downloadFrom(server.URL))
			var httpErr HTTPError
			if !errors.As(err, &httpErr) || httpErr.StatusCode != status || calls != 2 {
				t.Fatalf("status=%d calls=%d err=%v", status, calls, err)
			}
			info, err := os.Stat(partial)
			if err != nil || info.Size() != 1024 {
				t.Fatalf("valid partial lost: info=%v err=%v", info, err)
			}
		})
	}
}
