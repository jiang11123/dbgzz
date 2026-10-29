package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
)

type imageBudgetLimits struct{ closedAfter, checks int }

func (*imageBudgetLimits) GeneratedFileBytes(context.Context) (int64, error)  { return 1 << 20, nil }
func (*imageBudgetLimits) ResourceUploadBytes(context.Context) (int64, error) { return 1 << 20, nil }
func (l *imageBudgetLimits) CircuitOpen(context.Context, string) (bool, error) {
	l.checks++
	return l.checks <= l.closedAfter, nil
}
func (*imageBudgetLimits) AcquireChannelSlot(context.Context, string, string, time.Duration) (func(), int, error) {
	return func() {}, 1, nil
}
func (*imageBudgetLimits) RecordChannelResult(context.Context, string, bool) error { return nil }

func TestImageRecoveryPreDispatchWaitDoesNotSpendSendBudget(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"result"}]}`))
	}))
	defer server.Close()
	localURL, _ := url.Parse(server.URL)
	for _, accepted := range []bool{false, true} {
		t.Run(map[bool]string{false: "unconfirmed", true: "accepted"}[accepted], func(t *testing.T) {
			s, _, task, row, _ := imageSubmissionFixture(t, false)
			if accepted {
				if err := s.repo.MarkImageSubmissionAccepted(row); err != nil {
					t.Fatal(err)
				}
			}
			limits := &imageBudgetLimits{closedAfter: imageRecoveryMaxSends + 2}
			ctx := generation.WithRuntime(context.Background(), generation.Runtime{Limits: limits})
			before := hits.Load()
			waits := 0
			_, _, err := s.sendImageSubmissionWith(ctx, task, row, func(req *http.Request, admit func() error) ([]byte, string, error) {
				// Only redirect this test's immutable wire to the local HTTP fixture.
				req.URL = localURL
				return generation.DoBinaryWithDispatchAdmission(req, admit)
			}, func(context.Context, time.Duration) error {
				waits++
				stored, err := s.repo.ImageSubmission(row.AttemptID, task.ID, task.UserID)
				if err != nil || stored.SendCount != 0 || hits.Load() != before {
					t.Fatalf("preflight consumed budget: %+v %v", stored, err)
				}
				return nil
			})
			if err != nil || waits != limits.closedAfter || row.SendCount != 1 || hits.Load()-before != 1 {
				t.Fatalf("waits=%d sends=%d hits=%d err=%v", waits, row.SendCount, hits.Load()-before, err)
			}
		})
	}
}

func TestImageRecoveryUnknownTransportConsumesBudgetAndStaleOwnerCannotSend(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = conn.Close()
	}))
	defer server.Close()
	localURL, _ := url.Parse(server.URL)
	s, _, task, row, _ := imageSubmissionFixture(t, false)
	send := func(req *http.Request, admit func() error) ([]byte, string, error) {
		req.URL = localURL
		return generation.DoBinaryWithDispatchAdmission(withHTTPRequestRuntime(req), admit)
	}
	stale := task
	stale.LeaseOwner = "stale-owner"
	if _, _, err := s.sendImageSubmissionWith(context.Background(), stale, row, send, noImageWait); err == nil || hits.Load() != 0 || row.SendCount != 0 {
		t.Fatalf("stale owner dispatched: sends=%d hits=%d err=%v", row.SendCount, hits.Load(), err)
	}
	_, _, err := s.sendImageSubmissionWith(context.Background(), task, row, send, noImageWait)
	if !isImageRecoveryError(err) || hits.Load() != imageRecoveryMaxSends || row.SendCount != imageRecoveryMaxSends {
		t.Fatalf("unknown sends unbounded: sends=%d hits=%d err=%v", row.SendCount, hits.Load(), err)
	}
}

func TestImageRecoveryAdapterRestoresDiagnosticReceipt(t *testing.T) {
	s, _, task, row, _ := imageSubmissionFixture(t, false)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	ctx, recorder := withTaskRequestEvidence(ctx, nil)
	ctx = generation.WithRuntime(ctx, generation.Runtime{Limits: &imageBudgetLimits{closedAfter: 100}})
	_, _, err := s.sendImageSubmission(ctx, task, row)
	diagnostics := recorder.snapshot(false)
	if !errors.Is(err, context.DeadlineExceeded) || diagnostics == nil || len(diagnostics.Requests) != 1 || diagnostics.Requests[0].Dispatched || row.SendCount != 0 {
		t.Fatalf("missing preflight receipt: %#v err=%v sends=%d", diagnostics, err, row.SendCount)
	}
	// Restart execution uses processTask's explicit service binding before recovery.
	runtime, ok := generation.RuntimeFromContext(withProviderAnalytics(context.Background(), s, task))
	if !ok || runtime.Limits == nil || runtime.Receipts == nil {
		t.Fatal("task recovery runtime has no limits or receipts")
	}
}

func TestImageRecoveryPreDispatchWaitRemainsBounded(t *testing.T) {
	for _, cancellation := range []bool{false, true} {
		t.Run(map[bool]string{false: "deadline", true: "cancel"}[cancellation], func(t *testing.T) {
			s, _, task, row, _ := imageSubmissionFixture(t, false)
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			limits := &imageBudgetLimits{closedAfter: 1000}
			ctx = generation.WithRuntime(ctx, generation.Runtime{Limits: limits})
			wait := func(ctx context.Context, delay time.Duration) error {
				if cancellation {
					cancel()
				}
				return sleepContext(ctx, delay)
			}
			_, _, err := s.sendImageSubmissionWith(ctx, task, row, generation.DoBinaryWithDispatchAdmission, wait)
			want := context.DeadlineExceeded
			if cancellation {
				want = context.Canceled
			}
			if !errors.Is(err, want) || row.SendCount != 0 || limits.checks > 1 {
				t.Fatalf("sends=%d checks=%d err=%v", row.SendCount, limits.checks, err)
			}
		})
	}
}
