package outbound

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestResumableRefreshSignedURLRequiresMatchingStrongValidator(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, responseETag := range []string{`"v1"`, `"v2"`, `W/"v1"`, ""} {
		t.Run("response-etag="+responseETag, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if calls == 1 {
					if r.Header.Get("Range") != "bytes=3-" || r.Header.Get("If-Range") != `"v1"` {
						t.Errorf("missing validated resume headers: %v", r.Header)
					}
					w.Header().Set("ETag", responseETag)
					w.Header().Set("Content-Range", "bytes 3-5/6")
					w.WriteHeader(206)
					_, _ = w.Write([]byte("def"))
					return
				}
				if r.Header.Get("Range") != "" {
					t.Error("changed object retained old bytes")
				}
				_, _ = w.Write([]byte("uvwxyz"))
			}))
			defer server.Close()
			partial := filepath.Join(t.TempDir(), "test.part")
			if err := os.WriteFile(partial, []byte("abc"), 0600); err != nil {
				t.Fatal(err)
			}
			saveResumableSidecar(partial, resumableSidecar{URL: server.URL + "/image?signature=old", ETag: `"v1"`, Total: 6})
			got, err := DownloadResumable(context.Background(), server.URL+"/image?signature=new", ResumableOptions{PartialPath: partial, MaxBytes: 1024, Attempts: 2})
			want := "abcdef"
			if responseETag != `"v1"` {
				want = "uvwxyz"
			}
			if err != nil || string(got.Data) != want {
				t.Fatalf("download = %q %v", got.Data, err)
			}
		})
	}
}

func TestResumableExpiredSignaturePreservesPartial(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusForbidden) }))
	defer server.Close()
	partial := filepath.Join(t.TempDir(), "test.part")
	_ = os.WriteFile(partial, []byte("abc"), 0600)
	saveResumableSidecar(partial, resumableSidecar{URL: server.URL, ETag: `"v1"`, Total: 6})
	_, err := DownloadResumable(context.Background(), server.URL, ResumableOptions{PartialPath: partial, MaxBytes: 1024})
	if err == nil {
		t.Fatal("403 must fail")
	}
	data, err := os.ReadFile(partial)
	if err != nil || string(data) != "abc" {
		t.Fatalf("partial lost: %q %v", data, err)
	}
}
