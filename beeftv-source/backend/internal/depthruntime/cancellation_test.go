package depthruntime

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestEnsureSerializesInstallAndAllowsWaitingCancellation(t *testing.T) {
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	options := EnsureOptions{DataDir: t.TempDir(), Platform: "windows-amd64", Variant: "cpu", ManifestURL: server.URL}
	go func() { defer close(done); _, _ = Ensure(ctx, options) }()
	<-entered
	waitCtx, stop := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer stop()
	_, err := Ensure(waitCtx, options)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting installer: %v", err)
	}
	select {
	case <-entered:
		t.Fatal("parallel installer accessed shared files")
	default:
	}
	cancel()
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("installer did not cancel")
	}
}

func TestCancelledArchiveAndCopyStopBeforeWriting(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := extractRuntimeArchiveContext(ctx, "unused.zip", t.TempDir(), Artifact{}, 12<<30); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	var output bytes.Buffer
	_, err := io.Copy(&output, contextReader{ctx, bytes.NewBufferString("never copied")})
	if !errors.Is(err, context.Canceled) || output.Len() != 0 {
		t.Fatalf("copy=%q err=%v", output.String(), err)
	}
}
