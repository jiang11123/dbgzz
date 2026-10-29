package generation

import (
	"context"
	"io"
	"strconv"
	"sync"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
)

type ReferenceProgress = model.TaskReferenceProgress
type ReferenceProgressPort interface {
	ReportReference(ReferenceProgress)
	ClearReference()
}

type referenceProgressContext struct{}
type referenceReporter struct {
	mu    sync.Mutex
	ctx   context.Context
	port  ReferenceProgressPort
	value ReferenceProgress
	rate  outbound.ProgressRate
	last  time.Time
}

func referenceMediaLabel(kind string, index int) string {
	label := map[string]string{"image": "参考图片", "video": "参考视频", "audio": "参考音频"}[kind]
	if label == "" {
		label = "参考素材"
	}
	return label + " " + strconv.Itoa(index+1)
}

func beginReferenceProgress(ctx context.Context, label string, size int64) (context.Context, *referenceReporter) {
	runtime, _ := RuntimeFromContext(ctx)
	r := &referenceReporter{ctx: ctx, port: runtime.ReferenceProgress, value: ReferenceProgress{Label: label, TotalBytes: size, StartedAt: time.Now().UnixMilli()}}
	r.report("preparing", 0)
	return context.WithValue(ctx, referenceProgressContext{}, r), r
}

func (r *referenceReporter) report(phase string, loaded int64) {
	r.reportSample(phase, loaded, false)
}

// Already acknowledged chunks advance completion without being new traffic.
func (r *referenceReporter) resumeAt(loaded int64) {
	r.reportSample("transferring", loaded, true)
}

func (r *referenceReporter) reportSample(phase string, loaded int64, resetRate bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.port == nil || r.ctx.Err() != nil {
		return
	}
	now := time.Now()
	if resetRate || loaded < r.value.LoadedBytes {
		r.rate = outbound.ProgressRate{}
	}
	r.rate.Observe(now, loaded)
	r.value.Phase, r.value.LoadedBytes = phase, min(max(0, loaded), r.value.TotalBytes)
	r.value.BytesPerSecond = r.rate.Rate(now, loaded)
	r.value.UpdatedAt = now.UnixMilli()
	r.port.ReportReference(r.value)
}

func ReferenceUploadObserver(ctx context.Context, label string) func(int64, int64, string) {
	var reporter *referenceReporter
	var mu sync.Mutex
	return func(loaded, total int64, phase string) {
		mu.Lock()
		defer mu.Unlock()
		if reporter == nil {
			_, reporter = beginReferenceProgress(ctx, label, total)
		}
		reporter.report(phase, loaded)
	}
}

type referenceReader struct {
	io.Reader
	reporter *referenceReporter
	loaded   int64
}

func referenceUploadReader(ctx context.Context, reader io.Reader) io.Reader {
	r, _ := ctx.Value(referenceProgressContext{}).(*referenceReporter)
	if r == nil || r.port == nil {
		return reader
	}
	r.mu.Lock()
	loaded := r.value.LoadedBytes
	r.mu.Unlock()
	return &referenceReader{Reader: reader, reporter: r, loaded: loaded}
}

func (r *referenceReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.loaded += int64(n)
	if err != nil || r.loaded == r.reporter.value.TotalBytes || time.Since(r.reporter.last) >= 300*time.Millisecond {
		r.reporter.last = time.Now()
		phase := "transferring"
		if r.loaded == r.reporter.value.TotalBytes {
			phase = "processing"
		}
		r.reporter.report(phase, r.loaded)
	}
	return n, err
}
