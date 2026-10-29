package handler

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type assistantTestTransport struct{ calls int }

func (t *assistantTestTransport) RoundTrip(*http.Request) (*http.Response, error) {
	t.calls++
	return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("done"))}, nil
}

func TestAssistantChatClientPreservesCustomDefaultTransport(t *testing.T) {
	transport := &assistantTestTransport{}
	previous := http.DefaultTransport
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = previous })
	client := assistantChatClient(assistantChatHeaderTimeout)
	resp, err := client.Get("http://127.0.0.1/assistant")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if transport.calls != 1 || client.Timeout != 0 {
		t.Fatalf("custom transport not preserved: calls=%d timeout=%s", transport.calls, client.Timeout)
	}
}

// The chat stream lasts as long as the official turn, including model retries.
// Only the wait for response headers is bounded.
func TestAssistantChatClientBoundsHeadersNotTheStream(t *testing.T) {
	production := assistantChatClient(assistantChatHeaderTimeout)
	if production.Timeout != 0 {
		t.Fatalf("chat client has an overall deadline %s that cuts long turns", production.Timeout)
	}
	transport, ok := production.Transport.(*http.Transport)
	if !ok || transport.ResponseHeaderTimeout <= 0 {
		t.Fatalf("chat client must keep a response header timeout, got %#v", production.Transport)
	}
	if production.CheckRedirect == nil || production.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("chat client must not follow redirects with host credentials")
	}

	slowBody := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		for _, line := range []string{`{"type":"lifecycle","phase":"retry"}`, `{"type":"lifecycle","phase":"retry_end"}`, `{"type":"turn_end"}`} {
			_, _ = io.WriteString(w, line+"\n")
			w.(http.Flusher).Flush()
			time.Sleep(150 * time.Millisecond)
		}
	}))
	defer slowBody.Close()
	resp, err := assistantChatClient(100 * time.Millisecond).Get(slowBody.URL)
	if err != nil {
		t.Fatalf("headers arrived at once: %v", err)
	}
	body, readErr := io.ReadAll(resp.Body)
	resp.Body.Close()
	if readErr != nil || !strings.Contains(string(body), `"turn_end"`) {
		t.Fatalf("stream longer than the header timeout was cut: %v %q", readErr, body)
	}

	slowHeaders := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(400 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer slowHeaders.Close()
	if resp, err := assistantChatClient(100 * time.Millisecond).Get(slowHeaders.URL); err == nil {
		resp.Body.Close()
		t.Fatal("a host that never sends headers must still fail")
	}
}
