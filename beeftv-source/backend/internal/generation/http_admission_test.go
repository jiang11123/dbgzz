package generation

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

type dispatchLimits struct {
	stubLimits
	circuit  bool
	slotErr  error
	onSlot   func()
	releases int
}

func (l *dispatchLimits) CircuitOpen(context.Context, string) (bool, error) { return l.circuit, nil }
func (l *dispatchLimits) AcquireChannelSlot(context.Context, string, string, time.Duration) (func(), int, error) {
	if l.onSlot != nil {
		l.onSlot()
	}
	if l.slotErr != nil {
		return nil, 1, l.slotErr
	}
	return func() { l.releases++ }, 1, nil
}

func TestTransportDispatchAdmissionAfterPreflight(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()
	for _, stage := range []string{"circuit", "slot", "cancel-after-slot", "url", "fence", "sent"} {
		t.Run(stage, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			limits := &dispatchLimits{}
			url := server.URL
			switch stage {
			case "circuit":
				limits.circuit = true
			case "slot":
				limits.slotErr = errors.New("slot unavailable")
			case "cancel-after-slot":
				limits.onSlot = cancel
			case "url":
				url = "file:///denied"
			}
			receipts := &recordingReceipts{}
			ctx = WithRuntime(ctx, Runtime{Limits: limits, Receipts: receipts})
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
			if err != nil {
				t.Fatal(err)
			}
			admissions := 0
			before := hits.Load()
			_, _, err = DoBinaryWithDispatchAdmission(req, func() error {
				admissions++
				if stage == "fence" {
					return errors.New("stale owner")
				}
				return nil
			})
			wantAdmissions, wantHits := 0, int32(0)
			if stage == "fence" || stage == "sent" {
				wantAdmissions = 1
			}
			if stage == "sent" {
				wantHits = 1
			}
			if admissions != wantAdmissions || hits.Load()-before != wantHits || (err == nil) != (stage == "sent") {
				t.Fatalf("admissions=%d hits=%d err=%v", admissions, hits.Load()-before, err)
			}
			observed := receipts.snapshot()
			if len(observed) != 1 || observed[0].Dispatched != (stage == "sent") {
				t.Fatalf("receipt: %#v", observed)
			}
			if stage != "circuit" && stage != "slot" && limits.releases != 1 {
				t.Fatal("channel slot leaked")
			}
		})
	}
}
