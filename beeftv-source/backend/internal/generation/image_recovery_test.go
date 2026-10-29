package generation

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

type taggedImagePort struct {
	id   string
	seen *[]string
	mu   *sync.Mutex
}

func (p taggedImagePort) Intercept(*http.Request) (bool, []byte, string, error) {
	p.mu.Lock()
	*p.seen = append(*p.seen, p.id)
	p.mu.Unlock()
	return true, []byte(`{"data":[{"b64_json":"YQ=="}]}`), "application/json", nil
}

func beefAPIImageRequest(ctx context.Context) *http.Request {
	ctx = WithImageReplayProtocol(ctx, ImageReplayProtocol)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://beefapi.com/v1/images/generations", strings.NewReader(`{"prompt":"draw"}`))
	if err != nil {
		panic(err)
	}
	return req
}

func TestDoBinaryRecoverableImageMissingOwnerSendsZeroHTTP(t *testing.T) {
	expired, cancel := context.WithTimeout(context.Background(), 0)
	cancel()

	req := beefAPIImageRequest(expired)
	_, _, err := DoBinary(req)
	if !errors.Is(err, ErrImageOwnerMissing) {
		t.Fatalf("DoBinary() error = %v, want ErrImageOwnerMissing", err)
	}

	ctx := WithRuntime(expired, taskRuntime())
	req = beefAPIImageRequest(ctx)
	_, _, err = DoBinary(req)
	if !errors.Is(err, ErrImageOwnerMissing) {
		t.Fatalf("declined intercept error = %v, want ErrImageOwnerMissing", err)
	}
}

func TestBeefTVImageSubmissionKeepsRecoveryOwner(t *testing.T) {
	ctx, cancel := context.WithCancel(WithImageReplayProtocol(context.Background(), ImageReplayProtocol))
	cancel()
	for _, path := range []string{"/v1/images/generations", "/v1/images/edits"} {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://beeftv.app"+path, strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err = DoBinary(req); !errors.Is(err, ErrImageOwnerMissing) {
			t.Fatalf("BeefTV %s bypassed recovery owner: %v", path, err)
		}
	}
}

func TestDoBinaryNonBeefAPIStillPosts(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"b64_json":"YQ=="}]}`)
	}))
	t.Cleanup(server.Close)
	ctx := WithRuntime(context.Background(), taskRuntime())
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/images/generations", strings.NewReader(`{"prompt":"draw"}`))
	if err != nil {
		t.Fatal(err)
	}
	data, _, err := DoBinary(req)
	if err != nil || hits.Load() != 1 || !strings.Contains(string(data), "b64_json") {
		t.Fatalf("non-BeefAPI DoBinary: hits=%d err=%v data=%s", hits.Load(), err, data)
	}
}

func TestParallelImagePortsCannotStealOwner(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	ctxA := WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) {
		runtime.Images = taggedImagePort{id: "a", seen: &seen, mu: &mu}
	}))
	ctxB := WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) {
		runtime.Images = taggedImagePort{id: "b", seen: &seen, mu: &mu}
	}))
	var wg sync.WaitGroup
	var failed atomic.Int32
	for i := 0; i < 32; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if _, _, err := DoBinary(beefAPIImageRequest(ctxA)); err != nil {
				failed.Add(1)
			}
		}()
		go func() {
			defer wg.Done()
			if _, _, err := DoBinary(beefAPIImageRequest(ctxB)); err != nil {
				failed.Add(1)
			}
		}()
	}
	wg.Wait()
	if failed.Load() != 0 {
		t.Fatalf("intercept errors = %d", failed.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	var a, b int
	for _, id := range seen {
		switch id {
		case "a":
			a++
		case "b":
			b++
		default:
			t.Fatalf("unknown owner %q", id)
		}
	}
	if a != 32 || b != 32 {
		t.Fatalf("owner isolation lost: a=%d b=%d seen=%d", a, b, len(seen))
	}
}
