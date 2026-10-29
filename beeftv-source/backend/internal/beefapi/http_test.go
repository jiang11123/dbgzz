package beefapi

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestAuthorizationClientWithWrappedGlobalTransport(t *testing.T) {
	previous := http.DefaultTransport
	http.DefaultTransport = brandTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("authorization constructor made an outbound request")
		return nil, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previous })
	client := defaultHTTPClient(nil)
	if client == nil || client.Timeout <= 0 {
		t.Fatal("authorization client is not usable with global instrumentation")
	}
}

func TestAuthorizationFallbackReplaysUnsentBody(t *testing.T) {
	var calls int
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		body, _ := io.ReadAll(r.Body)
		if r.Method != "POST" || string(body) != `{"client_id":"synthetic"}` || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("fallback changed request: %s %s %s", r.Method, body, r.Header.Get("Content-Type"))
		}
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer server.Close()
	// Reserve then close a local port to get an actual proxy dial failure.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	proxy, _ := url.Parse("http://" + listener.Addr().String())
	listener.Close()
	var fallback bool
	client := defaultHTTPClient(func() { fallback = true })
	transport := client.Transport.(*authorizationTransport)
	primary := transport.primary.(*http.Transport)
	direct := transport.direct.(*http.Transport)
	primary.TLSClientConfig = server.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	direct.TLSClientConfig = primary.TLSClientConfig.Clone()
	defer primary.CloseIdleConnections()
	defer direct.CloseIdleConnections()
	transport.proxy = func(*http.Request) (*url.URL, error) { return proxy, nil }
	transport.explicit = func() bool { return false }
	req, _ := http.NewRequest("POST", server.URL, strings.NewReader(`{"client_id":"synthetic"}`))
	req.Header.Set("Content-Type", "application/json")
	response, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if !fallback || calls != 1 || response.StatusCode != 400 {
		t.Fatalf("fallback=%v calls=%d status=%d", fallback, calls, response.StatusCode)
	}
}

func TestAuthorizationPollNetworkFailureIsVisibleAndRecovers(t *testing.T) {
	svc, _, _ := testService(t, &fakeEnterprise{mode: "pending"})
	defer svc.Close()
	original := svc.httpClient.Transport
	resume := make(chan struct{})
	var tokens int
	svc.httpClient.Transport = brandTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/oauth/device/token" {
			tokens++
			if tokens == 1 {
				return nil, errors.New("synthetic network failure")
			}
			if tokens == 2 {
				select {
				case <-resume:
				case <-r.Context().Done():
					return nil, r.Context().Err()
				}
			}
		}
		return original.RoundTrip(r)
	})
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for svc.Status().ErrorReason != "连接中断，正在重试" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if status := svc.Status(); status.State != StatePending || status.ErrorReason != "连接中断，正在重试" {
		t.Fatalf("network failure hidden: %+v", status)
	}
	close(resume)
	deadline = time.Now().Add(2 * time.Second)
	for svc.Status().ErrorReason != "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if status := svc.Status(); status.State != StatePending || status.ErrorReason != "" {
		t.Fatalf("recovery not reflected: %+v", status)
	}
}

func TestAuthorizationDoesNotBypassOrRepeatSentRequests(t *testing.T) {
	proxy, _ := url.Parse("http://127.0.0.1:7890")
	dialErr := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("refused")}
	for _, tc := range []struct {
		name                                                 string
		explicit, connected, direct, cancelled, unreplayable bool
		status                                               int
		err                                                  error
	}{
		{name: "explicit proxy", explicit: true, err: dialErr},
		{name: "already connected", connected: true, err: dialErr},
		{name: "direct route", direct: true, err: dialErr},
		{name: "cancelled", cancelled: true, err: dialErr},
		{name: "unreplayable body", unreplayable: true, err: dialErr},
		{name: "certificate or protocol error", err: errors.New("certificate invalid")},
		{name: "server unavailable", status: 503},
		{name: "auth rejected", status: 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tc.cancelled {
				cancel()
			}
			req, _ := http.NewRequestWithContext(ctx, "POST", "https://example.com/auth", strings.NewReader("payload"))
			if tc.unreplayable {
				req.GetBody = nil
			}
			transport := &authorizationTransport{
				primary: brandTransport(func(r *http.Request) (*http.Response, error) {
					if tc.connected {
						httptrace.ContextClientTrace(r.Context()).GotConn(httptrace.GotConnInfo{})
					}
					if tc.status != 0 {
						return &http.Response{StatusCode: tc.status, Body: http.NoBody}, nil
					}
					return nil, tc.err
				}),
				direct: brandTransport(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected direct retry"); return nil, nil }),
				proxy: func(*http.Request) (*url.URL, error) {
					if tc.direct {
						return nil, nil
					}
					return proxy, nil
				},
				explicit: func() bool { return tc.explicit },
			}
			transport.RoundTrip(req)
		})
	}
}

func TestStartReportsConnectionFailureInsteadOfStorageFailure(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		err    error
		want   string
	}{
		{"network", 0, errors.New("synthetic secret-bearing transport failure"), "无法连接 BeefTV 服务，请检查网络后重试"},
		{"service", 503, nil, "BeefTV 连接服务暂时不可用，请稍后重试"},
		{"rate limit", 429, nil, "连接尝试过于频繁，请稍后重试"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, _, _ := testService(t, &fakeEnterprise{})
			defer svc.Close()
			svc.httpClient.Transport = brandTransport(func(*http.Request) (*http.Response, error) {
				if tc.err != nil {
					return nil, tc.err
				}
				return &http.Response{StatusCode: tc.status, Body: http.NoBody}, nil
			})
			summary, err := svc.Start(context.Background())
			if err == nil || summary.State != StateConnectionError || summary.ErrorReason != tc.want {
				t.Fatalf("summary=%+v error=%v", summary, err)
			}
		})
	}
}

func TestConfirmationFailureOffersRetryWithoutNewAuthorization(t *testing.T) {
	fake := &fakeEnterprise{completeMode: "never"}
	svc, _, _ := testService(t, fake)
	defer svc.Close()
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	failed := waitState(t, svc, StateConnectionError)
	if !failed.HasCredential || failed.ErrorReason != "连接确认失败，请重试" {
		t.Fatalf("failure hidden or credential lost: %+v", failed)
	}
	fake.mu.Lock()
	codes := fake.codes
	fake.completeMode = ""
	fake.mu.Unlock()
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	if fake.codes != codes {
		t.Fatal("retry started another browser authorization instead of finishing saved credential")
	}
}
