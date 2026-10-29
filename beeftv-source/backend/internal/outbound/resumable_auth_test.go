package outbound

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestResumableCredentialsNeverReturnAfterCrossOriginRedirect(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var origin *httptest.Server
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Provider-Key") != "" {
			t.Error("credentials reached CDN")
		}
		http.Redirect(w, r, origin.URL+"/final", 302)
	}))
	defer cdn.Close()
	origin = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			if r.Header.Get("Authorization") != "Bearer fixture" || r.Header.Get("X-Provider-Key") != "fixture" {
				t.Error("same-origin authentication missing")
			}
			http.Redirect(w, r, cdn.URL, 302)
			return
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Provider-Key") != "" {
			t.Error("credentials restored after redirect returned")
		}
		w.Write([]byte("original"))
	}))
	defer origin.Close()
	got, err := DownloadResumable(context.Background(), origin.URL+"/start", ResumableOptions{PartialPath: filepath.Join(t.TempDir(), "image.part"), MaxBytes: 1024, Headers: http.Header{"Authorization": []string{"Bearer fixture"}, "X-Provider-Key": []string{"fixture"}}})
	if err != nil || string(got.Data) != "original" {
		t.Fatalf("download: %v", err)
	}
}
