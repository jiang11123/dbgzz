package generation

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSeedanceSingleUploadRecovery(t *testing.T) {
	for _, scenario := range []struct {
		name           string
		puts, confirms int
		fails          bool
	}{
		{"healthy", 1, 1, false},
		{"put_ack_lost", 1, 1, false},
		{"partial_body", 2, 2, false},
		{"confirmation_ack_lost", 1, 2, false},
		{"persistent_put_503", 3, 3, true},
		{"storage_403", 1, 0, true},
		{"confirmation_401", 1, 1, true},
		{"confirmation_503", 1, 4, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
			data := bytes.Repeat([]byte("owned-fixture"), 1<<15)
			var mu sync.Mutex
			puts, confirms, other := 0, 0, 0
			stored := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/storage":
					puts++
					if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
						t.Error("gateway credential reached storage")
					}
					if scenario.name == "storage_403" {
						w.WriteHeader(403)
						return
					}
					if scenario.name == "persistent_put_503" {
						w.WriteHeader(503)
						return
					}
					if scenario.name == "partial_body" && puts == 1 {
						_, _ = io.CopyN(io.Discard, r.Body, 1024)
						conn, _, _ := w.(http.Hijacker).Hijack()
						_ = conn.Close()
						return
					}
					body, err := io.ReadAll(r.Body)
					if err != nil || !bytes.Equal(body, data) {
						t.Error("wrong uploaded bytes")
						return
					}
					stored = true
					if scenario.name == "put_ack_lost" && puts == 1 {
						conn, _, _ := w.(http.Hijacker).Hijack()
						_ = conn.Close()
						return
					}
				case "/v1/video-references/uploads/complete":
					confirms++
					var req struct {
						Ticket string `json:"ticket"`
					}
					if json.NewDecoder(r.Body).Decode(&req) != nil || req.Ticket != "same-owned-ticket" {
						t.Error("ticket changed")
					}
					if scenario.name == "confirmation_401" {
						w.WriteHeader(401)
						return
					}
					if scenario.name == "confirmation_503" {
						w.WriteHeader(503)
						return
					}
					if !stored {
						w.WriteHeader(400)
						_, _ = io.WriteString(w, `{"error":{"code":"video_reference_upload_incomplete","message":"not received"}}`)
						return
					}
					if scenario.name == "confirmation_ack_lost" && confirms == 1 {
						conn, _, _ := w.(http.Hijacker).Hijack()
						_ = conn.Close()
						return
					}
					_ = json.NewEncoder(w).Encode(BeefAPISeedanceUploadComplete{URL: "https://example.com/completed.png", Bytes: int64(len(data))})
				default:
					other++
					w.WriteHeader(500)
				}
			}))
			defer server.Close()
			receipts := &recordingReceipts{}
			ctx := WithRuntime(context.Background(), Runtime{Receipts: receipts, Endpoints: Endpoints{BeefAPIVideoBaseURL: server.URL}})
			ctx = withReferenceUpload(ctx, ReferenceUploadMeta{Kind: "image", Index: 1})
			_, err := CompleteBeefAPISeedanceUpload(ctx, Config{BaseURL: server.URL + "/v1", APIKey: "gateway-secret"}, BeefAPISeedanceUploadSession{Ticket: "same-owned-ticket", UploadURL: server.URL + "/storage?X-Amz-Signature=PRIVATE"}, data)
			mu.Lock()
			defer mu.Unlock()
			if (err != nil) != scenario.fails || puts != scenario.puts || confirms != scenario.confirms || other != 0 {
				t.Fatalf("err=%v puts=%d confirms=%d unexpected=%d", err, puts, confirms, other)
			}
			seen := receipts.snapshot()
			if len(seen) != puts+confirms {
				t.Fatalf("attempt evidence lost: %d", len(seen))
			}
			for _, receipt := range seen {
				meta, ok := ReferenceUploadFromContext(receipt.Request.Context())
				if !ok || meta.Attempt < 1 || meta.Attempt > 4 {
					t.Fatalf("missing attempt: %+v", meta)
				}
				if receipt.Err != nil && strings.Contains(DiagnosticSummary(receipt.Err.Error()), "PRIVATE") {
					t.Fatal("signed URL leaked")
				}
			}
		})
	}
}

func TestSeedanceUploadCertificateAndCancellationAreNotRetried(t *testing.T) {
	for _, cause := range []error{x509.UnknownAuthorityError{}, x509.HostnameError{}, x509.CertificateInvalidError{}, context.Canceled} {
		err := &ReferenceUploadError{Code: "upload_transport_error", Cause: cause}
		if retrySeedanceUpload(context.Background(), err, true) {
			t.Fatalf("permanent error retried: %T", cause)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	_, err := CompleteBeefAPISeedanceUpload(ctx, Config{}, BeefAPISeedanceUploadSession{Ticket: "owned"}, []byte("owned"))
	if !errors.Is(err, context.Canceled) || time.Since(started) > time.Second {
		t.Fatalf("cancel delayed: %v", err)
	}
}

func TestTransportTracePreservesDNSFailureAndRequestDispatch(t *testing.T) {
	trace := &transportTrace{}
	req, _ := http.NewRequest(http.MethodPost, "https://example.com", nil)
	req = trace.attach(req)
	callbacks := httptrace.ContextClientTrace(req.Context())
	callbacks.DNSStart(httptrace.DNSStartInfo{})
	callbacks.DNSDone(httptrace.DNSDoneInfo{Err: errors.New("lookup failed")})
	if dispatched, phase := trace.result(nil); dispatched || phase != "dns" {
		t.Fatalf("DNS evidence: %t %s", dispatched, phase)
	}
	callbacks.GotConn(httptrace.GotConnInfo{})
	callbacks.TLSHandshakeStart()
	if dispatched, phase := trace.result(nil); !dispatched || phase != "tls" {
		t.Fatal("later handshake erased earlier dispatch")
	}
}

func TestSeedanceUploadDNSValidationHonorsDeadline(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	previous := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		timer := time.NewTimer(250 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return nil, errors.New("owned slow DNS failure")
		}
	}}
	t.Cleanup(func() { net.DefaultResolver = previous })
	for _, operation := range []string{"validation", "put", "confirmation", "redirect"} {
		t.Run(operation, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
			defer cancel()
			receipts := &recordingReceipts{}
			ctx = WithRuntime(ctx, Runtime{Receipts: receipts})
			started := time.Now()
			var err error
			switch operation {
			case "validation":
				err = ValidateBeefAPISeedanceSecureURL(ctx, "https://owned-slow-dns.invalid/upload")
			case "put":
				err = PutBeefAPISeedanceBytes(ctx, BeefAPISeedanceUploadSession{UploadURL: "https://owned-slow-dns.invalid/upload"}, []byte("owned"))
			case "confirmation":
				req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://owned-slow-dns.invalid/complete", nil)
				_, _, err = DoBinary(req)
			case "redirect":
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					http.Redirect(w, r, "https://owned-slow-dns.invalid/complete", http.StatusFound)
				}))
				defer server.Close()
				req, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL, nil)
				_, _, err = DoBinary(req)
			}
			if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > 200*time.Millisecond {
				t.Fatalf("DNS validation ignored deadline: duration=%s error=%v", time.Since(started), err)
			}
			if operation != "validation" {
				seen := receipts.snapshot()
				if len(seen) != 1 || seen[0].Dispatched != (operation == "redirect") || seen[0].TransportPhase != "dns" {
					t.Fatalf("DNS failure evidence: %+v", seen)
				}
			}
		})
	}
}
