package generation

import (
	"context"
	"errors"
	"infinite-canvas/backend/internal/outbound"
	"net"
	"net/http"
	"strings"
	"time"
)

// ErrImageOwnerMissing is returned when a recoverable BeefAPI image POST has
// no Images port or the port declined to take ownership. Callers must not
// open a new upstream request.
var ErrImageOwnerMissing = errors.New("图片请求缺少恢复所有者")

const ImageReplayProtocol = "idempotency-key-v1"

type imageReplayProtocolContext struct{}

func WithImageReplayProtocol(ctx context.Context, protocol string) context.Context {
	return context.WithValue(ctx, imageReplayProtocolContext{}, protocol)
}

func imageSubmissionURL(req *http.Request) bool {
	return req != nil && req.URL != nil && req.Method == http.MethodPost && req.URL.Scheme == "https" && req.URL.Hostname() != "" && req.URL.User == nil && req.URL.RawQuery == "" && req.URL.Fragment == "" && (strings.HasSuffix(req.URL.Path, "/images/generations") || strings.HasSuffix(req.URL.Path, "/images/edits"))
}

// The endpoint advertises its replay contract; a hostname never grants it.
// Probe only metadata on the same origin and never forward credentials across
// a redirect. Unsupported endpoints keep their existing single-POST path.
func NegotiateImageReplay(req *http.Request) (*http.Request, error) {
	return negotiateImageReplay(req, outbound.OutboundHTTPClient(10*time.Second))
}

func negotiateImageReplay(req *http.Request, configured *http.Client) (*http.Request, error) {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		var negotiated *http.Request
		negotiated, err = probeImageReplay(req, configured)
		if err == nil {
			return negotiated, nil
		}
		// Only metadata GETs have run. Retrying a transient probe never sends
		// the paid image POST; cancellation and permanent failures stop here.
		var network net.Error
		if req == nil || req.Context().Err() != nil || !(errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &network) && (network.Timeout() || network.Temporary()))) {
			break
		}
	}
	return nil, RequestPreparationError{Cause: RequestNotSentError{Cause: err}}
}

func probeImageReplay(req *http.Request, configured *http.Client) (*http.Request, error) {
	if !imageSubmissionURL(req) || RecoverableImageEndpoint(req) {
		return req, nil
	}
	if err := req.Context().Err(); err != nil {
		return nil, err
	}
	u := *req.URL
	if strings.HasSuffix(u.Path, "/images/generations") {
		u.Path = strings.TrimSuffix(u.Path, "/images/generations") + "/models"
	} else {
		u.Path = strings.TrimSuffix(u.Path, "/images/edits") + "/models"
	}
	u.RawPath = ""
	if _, err := outbound.ValidateOutboundURL(u.String()); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(req.Context(), 10*time.Second)
	defer cancel()
	probe, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	probe.Header = req.Header.Clone()
	for _, name := range []string{"Content-Type", "Content-Length", "Transfer-Encoding", "Idempotency-Key", "X-Idempotency-Key"} {
		probe.Header.Del(name)
	}
	outbound.ApplyDefaultOutboundHeaders(probe)
	client := *configured
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(probe)
	if err != nil {
		if req.Context().Err() != nil {
			return nil, req.Context().Err()
		}
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && resp.Header.Get("X-Image-Submission-Protocol") == ImageReplayProtocol {
		return req.WithContext(WithImageReplayProtocol(req.Context(), ImageReplayProtocol)), nil
	}
	return req, nil
}

// RecoverableImageEndpoint requires an advertised protocol and a matching
// image submission URL. Unsupported providers stay on the single-POST path.
func RecoverableImageEndpoint(req *http.Request) bool {
	if !imageSubmissionURL(req) {
		return false
	}
	protocol, _ := req.Context().Value(imageReplayProtocolContext{}).(string)
	return protocol == ImageReplayProtocol
}
