package outbound

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestResumableTimeoutIsNotUserCancellation(t *testing.T) {
	allowLoopback(t)
	for _, phase := range []string{"headers", "body", "user-cancel"} {
		t.Run(phase, func(t *testing.T) {
			started := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if phase == "body" {
					w.Header().Set("Content-Length", "100")
					_, _ = w.Write([]byte("partial"))
					w.(http.Flusher).Flush()
				}
				close(started)
				<-r.Context().Done()
			}))
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if phase == "user-cancel" {
				go func() { <-started; cancel() }()
			}
			_, err := DownloadResumable(ctx, server.URL+"/artifact?t=secret-test-token", ResumableOptions{
				PartialPath: filepath.Join(t.TempDir(), "image.part"), MaxBytes: 1000, Attempts: 1,
				HeaderTimeout: 100 * time.Millisecond, IdleTimeout: 100 * time.Millisecond,
			})
			want := context.DeadlineExceeded
			if phase == "user-cancel" {
				want = context.Canceled
			}
			if !errors.Is(err, want) || (phase != "user-cancel" && errors.Is(err, context.Canceled)) {
				t.Fatalf("%s: got %v, want %v", phase, err, want)
			}
			if strings.Contains(err.Error(), "secret-test-token") {
				t.Fatal("signed artifact URL leaked into error")
			}
		})
	}
}

func TestResumableTransportFailureHidesSignedURL(t *testing.T) {
	allowLoopback(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { panic(http.ErrAbortHandler) }))
	defer server.Close()
	_, err := DownloadResumable(context.Background(), server.URL+"/artifact?t=secret-test-token", ResumableOptions{
		PartialPath: filepath.Join(t.TempDir(), "image.part"), MaxBytes: 1000, Attempts: 1,
	})
	if err == nil || strings.Contains(err.Error(), "secret-test-token") || strings.Contains(err.Error(), server.URL) {
		t.Fatalf("transport failure was lost or leaked its signed URL: %v", err)
	}
}
