package generation

import (
	"errors"
	"net/http"
	"net/http/httptrace"
	"sync/atomic"

	"infinite-canvas/backend/internal/outbound"
)

// Keep evidence for the whole Client.Do, including redirects. A later TLS
// failure cannot prove that the original POST was not received.
type transportTrace struct {
	connected atomic.Bool
	phase     atomic.Value
}

func (t *transportTrace) attach(req *http.Request) *http.Request {
	t.phase.Store("")
	trace := &httptrace.ClientTrace{
		DNSStart: func(httptrace.DNSStartInfo) { t.phase.Store("dns") },
		DNSDone: func(info httptrace.DNSDoneInfo) {
			if info.Err == nil {
				t.phase.Store("connect")
			} else {
				t.phase.Store("dns")
			}
		},
		ConnectStart:      func(string, string) { t.phase.Store("connect") },
		TLSHandshakeStart: func() { t.phase.Store("tls") },
		GotConn: func(httptrace.GotConnInfo) {
			t.connected.Store(true)
			t.phase.Store("request")
		},
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			if info.Err == nil {
				t.phase.Store("response_wait")
			}
		},
		GotFirstResponseByte: func() { t.phase.Store("response") },
	}
	return req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
}

func (t *transportTrace) result(err error) (bool, string) {
	phase, _ := t.phase.Load().(string)
	var dns *outbound.DNSResolutionError
	if errors.As(err, &dns) {
		// The resolver's own socket can emit ConnectStart before DNS fails.
		phase = "dns"
	}
	return t.connected.Load(), phase
}
