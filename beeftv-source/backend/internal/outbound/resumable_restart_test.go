package outbound

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
)

func TestDownloadResumableRestartOpenFailureKeepsOldValidator(t *testing.T) {
	allowLoopback(t)
	for _, validator := range []struct{ name, etag, modified string }{
		{"strong-etag", `"old"`, ""},
		{"weak-etag", `W/"old"`, ""},
		{"last-modified", "", "Wed, 14 Oct 2026 08:00:00 GMT"},
	} {
		t.Run(validator.name, func(t *testing.T) {
			fresh, old := []byte("new-prefix-and-tail"), []byte("OLD!")
			partial := filepath.Join(t.TempDir(), "artifact.part")
			held := partial + ".held"
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					// Replacing the path with a directory fails OpenFile even as
					// root, after the downloader has observed the old partial.
					if err := os.Rename(partial, held); err != nil {
						t.Error(err)
						http.Error(w, "fixture rename failed", 500)
						return
					}
					if err := os.Mkdir(partial, 0700); err != nil {
						t.Error(err)
						http.Error(w, "fixture mkdir failed", 500)
						return
					}
				}
				w.Header().Set("ETag", `"new"`)
				start := int64(0)
				if r.Header.Get("If-Range") == `"new"` {
					var ok bool
					start, ok = parseTestRange(r.Header.Get("Range"), int64(len(fresh)))
					if !ok {
						t.Errorf("invalid range: %s", r.Header.Get("Range"))
						w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
						return
					}
				}
				w.Header().Set("Content-Length", strconv.Itoa(len(fresh)-int(start)))
				if start > 0 {
					w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(fresh)-1, len(fresh)))
					w.WriteHeader(http.StatusPartialContent)
				}
				_, _ = w.Write(fresh[start:])
			}))
			defer server.Close()
			rawURL := server.URL + "/artifact.mp4"
			before := resumableSidecar{URL: rawURL, ETag: validator.etag, LastModified: validator.modified, Total: int64(len(fresh))}
			if err := os.WriteFile(partial, old, 0600); err != nil {
				t.Fatal(err)
			}
			if err := saveResumableSidecar(partial, before); err != nil {
				t.Fatal(err)
			}
			opts := ResumableOptions{PartialPath: partial, MaxBytes: 1024, Attempts: 1}
			if _, err := DownloadResumable(context.Background(), rawURL, opts); err == nil {
				t.Fatal("opening the directory as a partial file must fail")
			}
			if got := loadResumableSidecar(partial); got == nil || *got != before {
				t.Errorf("failed restart changed the old partial's validator: %+v", got)
			}
			if err := os.Remove(partial); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(held, partial); err != nil {
				t.Fatal(err)
			}
			result, err := DownloadResumable(context.Background(), rawURL, opts)
			if err != nil || !bytes.Equal(result.Data, fresh) {
				t.Fatalf("restart accepted mixed bytes: got %q, want %q, error %v", result.Data, fresh, err)
			}
			if calls.Load() != 2 {
				t.Fatalf("requests = %d, want 2", calls.Load())
			}
		})
	}
}

func TestDownloadResumableRestartSidecarFailureDoesNotWriteNewBytes(t *testing.T) {
	allowLoopback(t)
	fresh := []byte("new-prefix-and-tail")
	partial := filepath.Join(t.TempDir(), "artifact.part")
	held := partial + ".json.held"
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			if err := os.Rename(partial+".json", held); err != nil {
				t.Error(err)
				http.Error(w, "fixture rename failed", 500)
				return
			}
			if err := os.Mkdir(partial+".json", 0700); err != nil {
				t.Error(err)
				http.Error(w, "fixture mkdir failed", 500)
				return
			}
		} else if r.Header.Get("Range") != "" {
			t.Errorf("failed sidecar save retained resumable bytes: %s", r.Header.Get("Range"))
		}
		w.Header().Set("ETag", `"new"`)
		_, _ = w.Write(fresh)
	}))
	defer server.Close()
	rawURL := server.URL + "/artifact.mp4"
	if err := os.WriteFile(partial, []byte("OLD!"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := saveResumableSidecar(partial, resumableSidecar{URL: rawURL, ETag: `"old"`, Total: int64(len(fresh))}); err != nil {
		t.Fatal(err)
	}
	opts := ResumableOptions{PartialPath: partial, MaxBytes: 1024, Attempts: 1}
	if _, err := DownloadResumable(context.Background(), rawURL, opts); err == nil {
		t.Fatal("sidecar write failure must stop the download")
	}
	if data, err := os.ReadFile(partial); err != nil || len(data) != 0 {
		t.Fatalf("failed restart must leave no bytes paired with stale metadata: %q, %v", data, err)
	}
	if err := os.Remove(partial + ".json"); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(held, partial+".json"); err != nil {
		t.Fatal(err)
	}
	result, err := DownloadResumable(context.Background(), rawURL, opts)
	if err != nil || !bytes.Equal(result.Data, fresh) {
		t.Fatalf("retry = %q, want %q, error %v", result.Data, fresh, err)
	}
}
