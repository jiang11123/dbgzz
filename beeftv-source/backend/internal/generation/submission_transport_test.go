package generation

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func stalledTLS(t *testing.T) (string, func()) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		<-done
	}()
	return "https://" + l.Addr().String(), func() { close(done); l.Close() }
}

func TestVideoSubmissionBeforeTLSConnectionIsRetryable(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	address, closeServer := stalledTLS(t)
	defer closeServer()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	receipts := &recordingReceipts{}
	ctx = WithRuntime(ctx, Runtime{Receipts: receipts})
	err := PostJSONWithSubmissionKey(ctx, Config{BaseURL: address}, "/videos", map[string]string{"model": "test"}, &map[string]any{})
	err = UncertainVideoSubmission(ctx, err) // Same outer wrapper as RunSeedanceVideosTask.
	failure := ClassifyError(err)
	if failure.Uncertain || !failure.Retryable || failure.Category != CategoryRequestNotSent {
		t.Fatalf("pre-connection error must allow retry: err=%v failure=%+v", err, failure)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cause lost: %v", err)
	}
	seen := receipts.snapshot()
	if len(seen) != 1 || seen[0].Dispatched || seen[0].TransportPhase != "tls" || seen[0].TransportRoute != "direct" {
		t.Fatalf("unsent request marked dispatched: %+v", seen)
	}
}

func TestVideoSubmissionExplicitModelRejectionIsNotUncertain(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		rejected   bool
	}{
		{"unavailable-model", `{"error":{"code":"model_not_found","message":"分组 企业 下模型 grok-imagine-video-1.5 无可用渠道（distributor）"}}`, true},
		{"generic-unavailable", `{"error":{"code":"service_unavailable"}}`, false},
		{"text-only", `model_not_found`, false},
		{"lost-response", `{"error":{"code":"do_request_failed"}}`, false},
		{"has-task", `{"error":{"code":"model_not_found","task_id":"existing-task"}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := HTTPError{StatusCode: http.StatusServiceUnavailable, Body: tc.body}
			failure := ClassifyError(UncertainVideoSubmission(context.Background(), err))
			if SafeRouteRejection(err) != tc.rejected || failure.Uncertain == tc.rejected {
				t.Fatalf("incorrect submission classification: %+v", failure)
			}
		})
	}
}

func TestVideoSubmissionAfterRequestOrRedirectRemainsUncertain(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	stalled, closeServer := stalledTLS(t)
	defer closeServer()
	for _, redirect := range []bool{false, true} {
		t.Run(map[bool]string{false: "response-lost", true: "redirect-tls-failure"}[redirect], func(t *testing.T) {
			var hits atomic.Int32
			done := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				if redirect {
					http.Redirect(w, r, stalled+"/result", http.StatusFound)
					return
				}
				select {
				case <-r.Context().Done():
				case <-done:
				}
			}))
			defer server.Close()
			defer close(done)
			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			defer cancel()
			receipts := &recordingReceipts{}
			ctx = WithRuntime(ctx, Runtime{Receipts: receipts})
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/videos", strings.NewReader(`{"model":"test"}`))
			_, _, err := DoBinary(req)
			failure := ClassifyError(UncertainVideoSubmission(ctx, err))
			if hits.Load() != 1 || !failure.Uncertain || failure.Retryable {
				t.Fatalf("accepted request lost protection: hits=%d err=%v failure=%+v", hits.Load(), err, failure)
			}
			seen := receipts.snapshot()
			if len(seen) != 1 || !seen[0].Dispatched {
				t.Fatalf("prior connection lost on redirect: %+v", seen)
			}
		})
	}
}
