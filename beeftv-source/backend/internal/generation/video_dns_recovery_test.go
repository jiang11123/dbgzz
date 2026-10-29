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

	"golang.org/x/net/dns/dnsmessage"
	"infinite-canvas/backend/internal/outbound"
)

func controlledResolver(t *testing.T, code func() dnsmessage.RCode) {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		buffer := make([]byte, 4096)
		for {
			n, address, err := conn.ReadFrom(buffer)
			if err != nil {
				return
			}
			var query dnsmessage.Message
			if query.Unpack(buffer[:n]) != nil {
				continue
			}
			if code == nil {
				continue // A real DNS socket that never answers.
			}
			response := dnsmessage.Message{Header: dnsmessage.Header{ID: query.ID, Response: true, RecursionAvailable: true, RCode: code()}, Questions: query.Questions}
			if response.RCode == dnsmessage.RCodeSuccess {
				for _, q := range query.Questions {
					if q.Type == dnsmessage.TypeA {
						response.Answers = append(response.Answers, dnsmessage.Resource{Header: dnsmessage.ResourceHeader{Name: q.Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 1}, Body: &dnsmessage.AResource{A: [4]byte{127, 0, 0, 1}}})
					}
				}
			}
			body, err := response.Pack()
			if err == nil {
				_, _ = conn.WriteTo(body, address)
			}
		}
	}()
	previous := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "udp", conn.LocalAddr().String())
	}}
	t.Cleanup(func() { net.DefaultResolver = previous; _ = conn.Close(); <-done })
}

func TestDNSDeadlineKeepsDNSPhaseAfterResolverSocketConnect(t *testing.T) {
	controlledResolver(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	receipts := &recordingReceipts{}
	ctx = WithRuntime(ctx, Runtime{Receipts: receipts})
	var response map[string]any
	err := GetJSON(ctx, Config{BaseURL: "https://owned-dns-deadline.invalid", APIKey: "owned-test"}, "/videos/original", &response)
	seen := receipts.snapshot()
	if !errors.Is(err, context.DeadlineExceeded) || len(seen) != 1 || seen[0].Dispatched || seen[0].TransportPhase != "dns" {
		t.Fatalf("DNS socket deadline lost phase: err=%T observations=%d", err, len(seen))
	}
}

func TestVideoPollStageWriteFailureDoesNotInventProviderSyncFailure(t *testing.T) {
	var stages []string
	stageErr := errors.New("local stage write failed")
	ctx := WithRuntime(context.Background(), Runtime{Stages: stageRecorder{events: &stages, err: stageErr}})
	_, err := RunVideoPollLoop(ctx, "original", DefaultVideoPollPolicy(), func(context.Context) (VideoPollOutcome, error) {
		t.Fatal("query started after stage persistence failed")
		return VideoPollOutcome{}, nil
	})
	var pending StatePendingError
	if !errors.Is(err, stageErr) || errors.As(err, &pending) {
		t.Fatal("local persistence failure became an upstream synchronization failure")
	}
}

func TestVideoPollRecoversRealDNSFailureWithoutResubmission(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	t.Setenv("NO_PROXY", "*")
	t.Setenv("no_proxy", "*")
	var healthy atomic.Bool
	controlledResolver(t, func() dnsmessage.RCode {
		if healthy.Load() {
			return dnsmessage.RCodeSuccess
		}
		return dnsmessage.RCodeServerFailure
	})
	var gets, posts atomic.Int32
	queries, pauses := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			posts.Add(1)
			w.WriteHeader(500)
			return
		}
		gets.Add(1)
		if r.URL.Path != "/v1/videos/original-task" {
			t.Error("original task identity changed")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"completed"}`))
	}))
	defer server.Close()
	base := strings.Replace(server.URL, "127.0.0.1", "owned-dns-recovery.invalid", 1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var stages []string
	receipts := &recordingReceipts{}
	ctx = WithRuntime(ctx, Runtime{Stages: stageRecorder{events: &stages}, Receipts: receipts})
	var firstError error
	result, err := RunVideoPollLoop(ctx, "original-task", VideoPollPolicy{RetryTransient: true, Interval: time.Millisecond, Sleep: func(context.Context, time.Duration) error {
		pauses++
		healthy.Store(true)
		return nil
	}}, func(ctx context.Context) (VideoPollOutcome, error) {
		queries++
		var response map[string]any
		err := GetJSON(ctx, Config{BaseURL: base + "/v1", APIKey: "owned-test"}, "/videos/original-task", &response)
		if err != nil {
			if firstError == nil {
				firstError = err
			}
			return VideoPollOutcome{}, err
		}
		return VideoPollOutcome{Done: true, Result: response}, nil
	})
	var dns *outbound.DNSResolutionError
	var cause *net.DNSError
	if !errors.As(firstError, &dns) || !errors.As(firstError, &cause) || (!cause.IsTemporary && !cause.IsTimeout) {
		t.Fatalf("actual validator lost retryable DNS type: %T", firstError)
	}
	if err != nil || result["status"] != "completed" || queries != 2 || gets.Load() != 1 || posts.Load() != 0 || pauses != 1 {
		t.Fatalf("query-only recovery: err=%v queries=%d GET=%d POST=%d pauses=%d", err, queries, gets.Load(), posts.Load(), pauses)
	}
	seen := receipts.snapshot()
	if len(seen) != 2 {
		t.Fatalf("query observations=%d, want two", len(seen))
	}
	if seen[0].Dispatched || seen[0].TransportPhase != "dns" || !seen[1].Dispatched || len(stages) != 1 || stages[0] != "正在查询上游任务" {
		t.Fatalf("query phase or dispatch evidence lost: observations=%d stages=%q first=%t/%s second=%t/%s", len(seen), stages, seen[0].Dispatched, seen[0].TransportPhase, seen[len(seen)-1].Dispatched, seen[len(seen)-1].TransportPhase)
	}
	if strings.Contains(firstError.Error(), "owned-dns-recovery") {
		t.Fatal("resolver hostname leaked")
	}
	failure := ClassifyError(firstError)
	if failure.Category != CategoryNetwork || !failure.Retryable || !failure.BlocksAutomaticRetry() {
		t.Fatal("query retry must not permit automatic generation resubmission")
	}
}

func TestResumableDownloadRecordsDNSPreflightAndHonorsCancellation(t *testing.T) {
	controlledResolver(t, func() dnsmessage.RCode { return dnsmessage.RCodeServerFailure })
	for _, cancelled := range []bool{false, true} {
		receipts := &recordingReceipts{}
		ctx, cancel := context.WithCancel(WithRuntime(context.Background(), Runtime{Receipts: receipts}))
		if cancelled {
			cancel()
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://owned-result.invalid/result?signature=PRIVATE", nil)
		if err != nil {
			t.Fatal(err)
		}
		_, err = openVideoDownloadResponse(req, 1024)
		cancel()
		seen := receipts.snapshot()
		if err == nil || len(seen) != 1 || seen[0].Dispatched {
			t.Fatal("download preflight failure was not recorded")
		}
		if cancelled {
			if !errors.Is(err, context.Canceled) {
				t.Fatal("download ignored cancellation during URL validation")
			}
		} else {
			var dns *outbound.DNSResolutionError
			if !errors.As(err, &dns) || seen[0].TransportPhase != "dns" {
				t.Fatal("download resolver failure lost its phase")
			}
		}
	}
}

func TestVideoPollStopsPermanentDNSAndSecurityRejection(t *testing.T) {
	for _, scenario := range []string{"nxdomain", "blocked_address", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
			controlledResolver(t, func() dnsmessage.RCode {
				if scenario == "nxdomain" {
					return dnsmessage.RCodeNameError
				}
				return dnsmessage.RCodeSuccess
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if scenario == "cancelled" {
				cancel()
			}
			queries := 0
			_, err := RunVideoPollLoop(ctx, "original-task", VideoPollPolicy{RetryTransient: true, Sleep: func(context.Context, time.Duration) error { t.Fatal("permanent failure retried"); return nil }}, func(ctx context.Context) (VideoPollOutcome, error) {
				queries++
				_, err := outbound.ValidateOutboundURLContext(ctx, "https://owned-no-resubmit.invalid")
				return VideoPollOutcome{}, err
			})
			if err == nil || queries > 1 {
				t.Fatalf("did not stop: queries=%d error=%v", queries, err)
			}
			if scenario == "nxdomain" {
				var cause *net.DNSError
				if !errors.As(err, &cause) || !cause.IsNotFound || ClassifyError(err).Retryable {
					t.Fatal("NXDOMAIN became retryable")
				}
			}
			if scenario == "cancelled" && !errors.Is(err, context.Canceled) {
				t.Fatal("cancellation lost")
			}
		})
	}
}
