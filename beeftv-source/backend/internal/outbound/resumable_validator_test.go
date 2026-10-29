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

func TestDownloadResumableRestartsWithoutStrongValidator(t *testing.T) {
	allowLoopback(t)
	for _, tc := range []struct{ name, oldETag, newETag, oldModified, newModified string }{
		{"weak-etag-changed", `W/"old"`, `W/"new"`, "", ""},
		{"weak-etag-unchanged", `W/"same"`, `W/"same"`, "", ""},
		{"last-modified-changed", "", "", "Wed, 14 Oct 2026 08:00:00 GMT", "Thu, 15 Oct 2026 08:00:00 GMT"},
		{"last-modified-unchanged", "", "", "Wed, 14 Oct 2026 08:00:00 GMT", "Wed, 14 Oct 2026 08:00:00 GMT"},
		{"no-validator", "", "", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			old, fresh := []byte("OLD!prefix-and-tail"), []byte("new-prefix-and-tail")
			var calls atomic.Int32
			secondHeaders := make(chan http.Header, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					w.Header().Set("ETag", tc.oldETag)
					w.Header().Set("Last-Modified", tc.oldModified)
					w.Header().Set("Content-Length", strconv.Itoa(len(old)))
					_, _ = w.Write(old[:4])
					w.(http.Flusher).Flush()
					panic(http.ErrAbortHandler)
				}
				secondHeaders <- r.Header.Clone()
				w.Header().Set("ETag", tc.newETag)
				w.Header().Set("Last-Modified", tc.newModified)
				if r.Header.Get("Range") != "" {
					// Simulate an upstream that fails to enforce If-Range. This
					// tail must not be combined with an unvalidated old prefix.
					w.Header().Set("Content-Range", fmt.Sprintf("bytes 4-%d/%d", len(fresh)-1, len(fresh)))
					w.WriteHeader(http.StatusPartialContent)
					_, _ = w.Write(fresh[4:])
					return
				}
				_, _ = w.Write(fresh)
			}))
			defer server.Close()
			partial := filepath.Join(t.TempDir(), "artifact.part")
			opts := ResumableOptions{PartialPath: partial, MaxBytes: 1024, Attempts: 1}
			if _, err := DownloadResumable(context.Background(), server.URL, opts); err == nil {
				t.Fatal("initial interrupted response must fail")
			}
			if data, err := os.ReadFile(partial); err != nil || !bytes.Equal(data, old[:4]) {
				t.Fatalf("interrupted response was not cached: %q, %v", data, err)
			}
			result, err := DownloadResumable(context.Background(), server.URL, opts)
			if err != nil || !bytes.Equal(result.Data, fresh) {
				t.Errorf("download accepted mixed representations: got %q, want %q, error %v", result.Data, fresh, err)
			}
			select {
			case headers := <-secondHeaders:
				if headers.Get("Range") != "" || headers.Get("If-Range") != "" {
					t.Errorf("unvalidated partial sent range headers: %v", headers)
				}
			default:
				t.Error("restart did not reach the HTTP server")
			}
			if calls.Load() != 2 {
				t.Fatalf("requests = %d, want 2", calls.Load())
			}
		})
	}
}

func TestDownloadResumableFullRequestFailurePreservesPartial(t *testing.T) {
	allowLoopback(t)
	for _, validator := range []struct{ name, etag, modified string }{
		{"weak-etag", `W/"old"`, ""},
		{"last-modified", "", "Wed, 14 Oct 2026 08:00:00 GMT"},
		{"no-validator", "", ""},
	} {
		for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, 0} {
			t.Run(fmt.Sprintf("%s/status-%d", validator.name, status), func(t *testing.T) {
				requestHeaders := make(chan http.Header, 1)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requestHeaders <- r.Header.Clone()
					if status == 0 {
						panic(http.ErrAbortHandler)
					}
					w.WriteHeader(status)
				}))
				defer server.Close()
				partial := filepath.Join(t.TempDir(), "artifact.part")
				old := []byte("OLD!")
				before := resumableSidecar{URL: server.URL + "/artifact?signature=old", ETag: validator.etag, LastModified: validator.modified, Total: 19}
				if err := os.WriteFile(partial, old, 0600); err != nil {
					t.Fatal(err)
				}
				if err := saveResumableSidecar(partial, before); err != nil {
					t.Fatal(err)
				}
				_, err := DownloadResumable(context.Background(), server.URL+"/artifact?signature=new", ResumableOptions{PartialPath: partial, MaxBytes: 1024, Attempts: 1})
				if err == nil {
					t.Fatal("failed full request must not return cached bytes as success")
				}
				if data, err := os.ReadFile(partial); err != nil || !bytes.Equal(data, old) {
					t.Errorf("full request failure discarded partial: %q, %v", data, err)
				}
				if got := loadResumableSidecar(partial); got == nil || *got != before {
					t.Errorf("full request failure changed sidecar: %+v", got)
				}
				select {
				case headers := <-requestHeaders:
					if headers.Get("Range") != "" || headers.Get("If-Range") != "" {
						t.Errorf("unvalidated partial sent range headers: %v", headers)
					}
				default:
					t.Error("full request did not reach the HTTP server")
				}
			})
		}
	}
}
