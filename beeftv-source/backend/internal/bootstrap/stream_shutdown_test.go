package bootstrap

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// A canvas/task event stream waits on Request.Context. It must release before
// Shutdown's deadline, rather than consuming the worker's whole exit budget.
func TestRuntimeShutdownCancelsOpenEventStreams(t *testing.T) {
	r, err := Open(t.Context(), Config{Profile: ProfileDesktop, DataDir: t.TempDir(), ListenAddr: "127.0.0.1:0", AutoMigrate: true, ShutdownTimeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close(context.Background()) })
	ended := make(chan struct{})
	original := r.handler
	r.handler = http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/event-stream-fixture" {
			original.ServeHTTP(w, request)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-request.Context().Done()
		close(ended)
	})
	if err := r.Start(); err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+r.listener.Addr().String()+"/event-stream-fixture", nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	if err := r.Close(ctx); err != nil {
		t.Fatalf("open event stream blocked application exit: %v", err)
	}
	select {
	case <-ended:
	default:
		t.Fatal("application closed without releasing the stream context")
	}
}
