package bootstrap

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

type outboundCounter struct{ calls atomic.Int64 }

func (c *outboundCounter) RoundTrip(*http.Request) (*http.Response, error) {
	c.calls.Add(1)
	return nil, errors.New("unexpected outbound request during local startup")
}

func TestDesktopColdOpenBudgetAndNoIdleOutbound(t *testing.T) {
	counter := &outboundCounter{}
	previous := http.DefaultTransport
	http.DefaultTransport = counter
	defer func() { http.DefaultTransport = previous }()
	started := time.Now()
	runtime, err := Open(context.Background(), Config{Profile: ProfileDesktop, DataDir: t.TempDir(), ListenAddr: "127.0.0.1:0", AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	openDuration := time.Since(started)
	if err := runtime.Start(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if err := runtime.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls := counter.calls.Load(); calls != 0 {
		t.Fatalf("fresh local startup made %d outbound requests", calls)
	}
	if openDuration > 5*time.Second {
		t.Fatalf("fresh local Open took %s, budget is 5s", openDuration)
	}
	t.Logf("local_open_ms=%d idle_outbound_requests=0", openDuration.Milliseconds())
}
