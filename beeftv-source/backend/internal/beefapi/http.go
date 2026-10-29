package beefapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"sync/atomic"
	"time"

	"infinite-canvas/backend/internal/desktopnet"
)

type authorizationProxyKey struct{}

// This transport is used only by account authorization, never by generation.
// GotConn fires after HTTPS negotiation, before application bytes are sent.
type authorizationTransport struct {
	primary    http.RoundTripper
	direct     http.RoundTripper
	proxy      func(*http.Request) (*url.URL, error)
	explicit   func() bool
	onFallback func()
}

func defaultHTTPClient(onFallback func()) *http.Client {
	// Authorization owns its timeout and proxy policy. The global transport may
	// be wrapped by runtime instrumentation and is not necessarily a Transport.
	primary := &http.Transport{
		DialContext:       (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2: true, MaxIdleConns: 100, IdleConnTimeout: 90 * time.Second,
		TLSHandshakeTimeout: 8 * time.Second, ExpectContinueTimeout: time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
	}
	primary.Proxy = func(r *http.Request) (*url.URL, error) {
		proxy, _ := r.Context().Value(authorizationProxyKey{}).(*url.URL)
		return proxy, nil
	}
	direct := primary.Clone()
	direct.Proxy = nil
	return &http.Client{
		Timeout: 30 * time.Second,
		Transport: &authorizationTransport{primary: primary, direct: direct, proxy: desktopnet.Proxy,
			explicit: desktopnet.ExplicitProxyConfigured, onFallback: onFallback},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func (t *authorizationTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	explicit := t.explicit()
	proxy, err := t.proxy(req)
	if err != nil {
		return nil, err
	}
	var connected atomic.Bool
	ctx := context.WithValue(req.Context(), authorizationProxyKey{}, proxy)
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotConn: func(httptrace.GotConnInfo) { connected.Store(true) }})
	response, err := t.primary.RoundTrip(req.Clone(ctx))
	if err == nil || response != nil || proxy == nil || explicit || t.explicit() || connected.Load() || req.Context().Err() != nil || req.URL.Scheme != "https" || !connectionEstablishmentError(err) {
		return response, err
	}
	// A non-empty body must be replayable, even though no application bytes went out.
	retry := req.Clone(req.Context())
	if req.Body != nil && req.Body != http.NoBody {
		if req.GetBody == nil {
			return nil, err
		}
		retry.Body, err = req.GetBody()
		if err != nil {
			return nil, err
		}
	}
	if t.onFallback != nil {
		t.onFallback()
	}
	return t.direct.RoundTrip(retry)
}

func connectionEstablishmentError(err error) bool {
	for cause := err; cause != nil; cause = errors.Unwrap(cause) {
		if op, ok := cause.(*net.OpError); ok && op.Op == "dial" {
			return true
		}
	}
	var network net.Error
	return errors.As(err, &network) && network.Timeout()
}
