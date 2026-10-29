package generation

import (
	"context"
	"io"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

// downloadProgressInterval throttles byte observations; the final read (io.EOF
// or a read error) is always observed so the last count is never lost.
const downloadProgressInterval = 500 * time.Millisecond

type downloadObserverContext struct{}

// downloadObserver receives the bytes read from a response body. total is -1
// when the server did not declare a length.
type downloadObserver func(downloaded, total int64)

// withDownloadObserver scopes byte observation to one download attempt. Requests
// without an observer read the body exactly as before.
func withDownloadObserver(ctx context.Context, observe downloadObserver) context.Context {
	return context.WithValue(ctx, downloadObserverContext{}, observe)
}

func downloadObserverFrom(ctx context.Context) downloadObserver {
	observe, _ := ctx.Value(downloadObserverContext{}).(downloadObserver)
	return observe
}

type progressReader struct {
	reader   io.Reader
	total    int64
	read     int64
	cap      int64
	observe  downloadObserver
	lastSent time.Time
}

// newProgressReader reports total as the response's declared length; net/http
// already uses -1 when the server did not send one. Reported bytes never exceed
// keep, the amount the caller retains; a read past it is the caller's overflow.
func newProgressReader(reader io.Reader, contentLength, keep int64, observe downloadObserver) io.Reader {
	return &progressReader{reader: reader, total: contentLength, cap: keep, observe: observe}
}

func (r *progressReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.read += int64(n)
	now := time.Now()
	// A read past cap is the overflow the caller rejects, so it is the final count.
	overflow := r.read > r.cap
	if err != nil || overflow || now.Sub(r.lastSent) >= downloadProgressInterval {
		r.lastSent = now
		r.observe(min(r.read, r.cap), r.total)
	}
	return n, err
}

// videoDownloadReporter turns attempt-level byte observations into delivery
// progress for one task. It is inert when the runtime has no Delivery port.
type videoDownloadReporter struct {
	port       DeliveryProgressPort
	attempt    int
	downloaded int64
	total      int64
	rate       outbound.ProgressRate
}

func newVideoDownloadReporter(port DeliveryProgressPort) *videoDownloadReporter {
	if port == nil {
		return nil
	}
	return &videoDownloadReporter{port: port, total: -1}
}

func (r *videoDownloadReporter) report(state string, downloaded, total int64) {
	// A count that drops within one attempt means the body restarted (for
	// example the proxy retry after a failed direct read); speed starts over.
	if downloaded == 0 || downloaded < r.downloaded {
		r.rate = outbound.ProgressRate{}
	}
	r.downloaded = downloaded
	r.total = total
	now := time.Now()
	r.rate.Observe(now, downloaded)
	r.port.ReportDelivery(outbound.ResumableProgress{
		DownloadedBytes: downloaded,
		TotalBytes:      total,
		BytesPerSecond:  r.rate.Rate(now, downloaded),
		Attempt:         r.attempt,
		State:           state,
	})
}

// beginAttempt reports the attempt as started and returns a context whose body
// reads are reported as "downloading" for this attempt.
func (r *videoDownloadReporter) beginAttempt(ctx context.Context, attempt int) context.Context {
	if r == nil {
		return ctx
	}
	r.attempt = attempt
	r.rate = outbound.ProgressRate{}
	r.report("downloading", r.downloaded, r.total)
	return withDownloadObserver(ctx, func(downloaded, total int64) {
		r.report("downloading", downloaded, total)
	})
}

// The next response validates whether retained bytes can be resumed.
func (r *videoDownloadReporter) waitForRetry(nextAttempt int, pending bool) {
	if r == nil {
		return
	}
	r.attempt = nextAttempt
	r.rate = outbound.ProgressRate{}
	state := "retrying"
	if pending {
		state = "waiting"
	}
	r.report(state, r.downloaded, r.total)
}

func (r *videoDownloadReporter) clear() {
	if r == nil {
		return
	}
	r.port.ClearDelivery()
}
