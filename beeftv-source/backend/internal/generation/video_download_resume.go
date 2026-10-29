package generation

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

type videoDownloadPartialContext struct{}

func withVideoDownloadPartial(ctx context.Context) (context.Context, func(), error) {
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.DownloadCache != nil {
		if path := strings.TrimSpace(runtime.DownloadCache.PartialPath()); path != "" {
			return context.WithValue(ctx, videoDownloadPartialContext{}, path), func() {}, nil
		}
	}
	directory, err := os.MkdirTemp("", "beeftv-video-download-")
	if err != nil {
		return ctx, nil, err
	}
	return context.WithValue(ctx, videoDownloadPartialContext{}, filepath.Join(directory, "video.part")), func() { _ = os.RemoveAll(directory) }, nil
}

func getResumableVideoBinary(req *http.Request, partial string) ([]byte, string, error) {
	ctx := req.Context()
	var err error
	limit := MaxResponseBytes
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.Limits != nil {
		limit, err = runtime.Limits.GeneratedFileBytes(ctx)
		if err != nil {
			return nil, "", err
		}
	}
	if limit <= 0 {
		return nil, "", outbound.ErrResourceTooLarge
	}
	if runtime.Limits != nil {
		slot := runtime.Call.ChannelID
		if slot == "" {
			slot = "custom:" + strings.ToLower(req.URL.Host)
		}
		release, concurrencyLimit, err := runtime.Limits.AcquireChannelSlot(ctx, runtime.Call.ChannelID, slot, time.Until(PollingDeadline(ctx))+time.Minute)
		if err != nil {
			return nil, "", err
		}
		defer release()
		runtime.Call.ConcurrencyLimit = concurrencyLimit
		ctx = WithRuntime(ctx, runtime)
		req = req.WithContext(ctx)
	}
	headers := req.Header.Clone()
	headers.Del("Range")
	headers.Del("If-Range")
	total := int64(-1)
	result, err := outbound.DownloadResumable(ctx, req.URL.String(), outbound.ResumableOptions{
		PartialPath: partial, Headers: headers, MaxBytes: limit + 1,
		Attempts: 1, HeaderTimeout: 45 * time.Second, IdleTimeout: videoDeliveryIdleTimeout,
		OpenResponse: func(request *http.Request) (*http.Response, error) { return openVideoDownloadResponse(request, limit) },
		OnProgress: func(update outbound.ResumableProgress) {
			total = update.TotalBytes
			if observe := downloadObserverFrom(ctx); observe != nil {
				observe(update.DownloadedBytes, update.TotalBytes)
			}
		},
	})
	// The shared downloader throttles body progress. Report the final retained
	// count here too, including a short read that ended inside that interval.
	if observe := downloadObserverFrom(ctx); observe != nil {
		downloaded := int64(len(result.Data))
		if err != nil {
			if info, statErr := os.Stat(partial); statErr == nil {
				downloaded = info.Size()
			}
		}
		observe(downloaded, total)
	}
	// The resumable transport's own header/idle timer cancels an attempt without
	// canceling the owning task. The existing video loop owns the next attempt.
	if errors.Is(err, context.Canceled) && ctx.Err() == nil {
		err = context.DeadlineExceeded
	}
	return result.Data, result.MimeType, err
}

// Preserve the generation transport's credentials policy while keeping range
// headers across the gateway's cross-origin redirect to a signed media URL.
func videoDownloadHTTPClient(req *http.Request, timeout time.Duration) *http.Client {
	client := outbound.OutboundHTTPClient(timeout)
	checkRedirect := client.CheckRedirect
	credentials, _ := req.Context().Value(videoCredentialContext{}).(videoProviderCredentials)
	leftOrigin := false
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if err := checkRedirect(next, via); err != nil {
			return err
		}
		if !SameProviderOrigin(req.URL.String(), next.URL.String()) {
			leftOrigin = true
		}
		if leftOrigin {
			rangeValue, validator := next.Header.Get("Range"), next.Header.Get("If-Range")
			next.Header = make(http.Header)
			outbound.ApplyDefaultOutboundHeaders(next)
			if rangeValue != "" {
				next.Header.Set("Range", rangeValue)
			}
			if validator != "" {
				next.Header.Set("If-Range", validator)
			}
			stripVideoCredentialQuery(next.URL, credentials.Values)
		}
		return nil
	}
	if noRedirect, _ := req.Context().Value(binaryNoRedirectContext{}).(bool); noRedirect {
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	return client
}

func openVideoDownloadResponse(req *http.Request, limit int64) (*http.Response, error) {
	credentials, _ := req.Context().Value(videoCredentialContext{}).(videoProviderCredentials)
	if !SameProviderOrigin(credentials.Origin, req.URL.String()) {
		stripVideoCredentialQuery(req.URL, credentials.Values)
	}
	runtime, _ := RuntimeFromContext(req.Context())
	observation := TransportObservation{Request: req, StartedAt: time.Now(), ResponseLimitBytes: limit}
	trace := &transportTrace{}
	req = trace.attach(req)
	if _, err := outbound.ValidateOutboundURLContext(req.Context(), req.URL.String()); err != nil {
		observation.Dispatched, observation.TransportPhase = trace.result(err)
		observation.Err = err
		if runtime.Receipts != nil {
			runtime.Receipts.Observe(observation)
		}
		return nil, err
	}
	response, err := videoDownloadHTTPClient(req, 0).Do(req)
	observation.Dispatched, observation.TransportPhase = trace.result(err)
	if err != nil {
		observation.Err = err
		if runtime.Receipts != nil {
			runtime.Receipts.Observe(observation)
		}
		return nil, err
	}
	observation.StatusCode, observation.HTTPStatus = response.StatusCode, response.StatusCode
	observation.DeclaredResponseBytes = response.ContentLength
	observation.RequestID = firstNonEmpty(response.Header.Get("X-Request-Id"), response.Header.Get("Request-Id"))
	if transport, ok := outbound.OutboundHTTPClient(0).Transport.(*http.Transport); ok {
		observation.TransportRoute = "direct"
		if transport.Proxy != nil {
			if proxy, proxyErr := transport.Proxy(response.Request); proxyErr == nil && proxy != nil {
				observation.TransportRoute = "proxy"
			}
		}
	}
	body := &videoObservedBody{ReadCloser: response.Body, observation: observation, receipts: runtime.Receipts}
	response.Body = body
	if (response.StatusCode < 200 || response.StatusCode >= 300) && response.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		raw, _ := io.ReadAll(io.LimitReader(body, 64<<10))
		var resultErr error = HTTPError{StatusCode: response.StatusCode, Status: response.Status, Body: string(raw), RequestID: observation.RequestID, RetryAfter: ParseRetryAfter(response.Header.Get("Retry-After"), time.Now())}
		if !SameProviderOrigin(req.URL.String(), response.Request.URL.String()) && (response.StatusCode == 401 || response.StatusCode == 403) {
			resultErr = videoBackupLinkExpiredError{cause: resultErr}
		}
		// OpenResponse returns before the shared downloader can classify HTTP
		// errors. A rejected Range must not pin every later attempt to the same
		// invalid offset. Keep bytes for authentication and temporary failures.
		retry, _ := RetryableVideoPollError(context.WithoutCancel(req.Context()), resultErr)
		if response.StatusCode != http.StatusUnauthorized && response.StatusCode != http.StatusForbidden && !retry {
			if partial, _ := req.Context().Value(videoDownloadPartialContext{}).(string); partial != "" {
				_ = os.Remove(partial)
				_ = os.Remove(partial + ".json")
			}
			if response.StatusCode == http.StatusBadRequest && req.Header.Get("Range") != "" {
				resultErr = fmt.Errorf("%w: %w", outbound.ErrResumeRestart, resultErr)
			}
		}
		body.observation.Err = resultErr
		_ = body.Close()
		return nil, resultErr
	}
	return response, nil
}

type videoObservedBody struct {
	io.ReadCloser
	observation TransportObservation
	receipts    ReceiptPort
}

func (b *videoObservedBody) Read(data []byte) (int, error) {
	n, err := b.ReadCloser.Read(data)
	b.observation.ReceivedBytes += int64(n)
	if err != nil && !errors.Is(err, io.EOF) {
		b.observation.Err = err
	}
	return n, err
}

func (b *videoObservedBody) Close() error {
	err := b.ReadCloser.Close()
	if b.receipts != nil {
		b.receipts.Observe(b.observation)
	}
	return err
}
