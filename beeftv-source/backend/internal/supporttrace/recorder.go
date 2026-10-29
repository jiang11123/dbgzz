package supporttrace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type contextFields struct{}

// Recorder keeps diagnostic metadata only. It does not schedule, retry or
// recover business work, and does not configure a global OTel provider.
type Recorder struct {
	mu       sync.Mutex
	journal  *journal
	provider *sdktrace.TracerProvider
	tracer   trace.Tracer
	launchID string
	closed   bool
}

func New(dataDir string) (*Recorder, error) {
	j, err := openJournal(dataDir)
	if err != nil {
		return nil, err
	}
	r := &Recorder{journal: j, launchID: randomID()}
	r.provider = sdktrace.NewTracerProvider(
		sdktrace.WithResource(resource.Empty()),
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithIDGenerator(localIDGenerator{}),
		sdktrace.WithSpanProcessor(localProcessor{recorder: r}),
	)
	r.tracer = r.provider.Tracer("beeftv.support")
	return r, nil
}

// Extract accepts only W3C trace context. Baggage is intentionally not imported.
func Extract(ctx context.Context, headers http.Header) context.Context {
	return propagation.TraceContext{}.Extract(nonNil(ctx), propagation.HeaderCarrier(headers))
}

func TraceID(ctx context.Context) string {
	sc := trace.SpanContextFromContext(nonNil(ctx))
	if !sc.IsValid() {
		return ""
	}
	return sc.TraceID().String()
}

func SpanID(ctx context.Context) string {
	sc := trace.SpanContextFromContext(nonNil(ctx))
	if !sc.IsValid() {
		return ""
	}
	return sc.SpanID().String()
}

// Start synchronously writes and syncs a start checkpoint before returning.
// Empty end reason denotes success; a machine-readable reason denotes failure.
// Recording failures are counted in coverage and never fail business work.
func (r *Recorder) Start(ctx context.Context, name string, fields Fields) (context.Context, func(string)) {
	ctx = nonNil(ctx)
	if r == nil || !r.enabled() {
		return ctx, func(string) {}
	}
	parent, _ := ctx.Value(contextFields{}).(Fields)
	if parent.UserID != "" && fields.UserID != "" && parent.UserID != fields.UserID {
		r.reject(parent.UserID)
		// Do not return another owner's diagnostic scope to the caller when a
		// nested start is rejected. Cancellation/deadlines remain intact.
		ctx = context.WithValue(ctx, contextFields{}, Fields{})
		ctx = trace.ContextWithSpanContext(ctx, trace.SpanContext{})
		return ctx, func(string) {}
	}
	fields, ok := r.fields(ctx, name, fields)
	if !ok {
		return ctx, func(string) {}
	}
	parentID := SpanID(ctx)
	ctx = context.WithValue(ctx, contextFields{}, fields)
	ctx, span := r.tracer.Start(ctx, name, trace.WithAttributes(fieldAttributes(fields)...))
	r.record(Event{Fields: fields, ID: randomID(), Timestamp: time.Now().UTC(), Name: name, Phase: "start", LaunchID: r.launchID, TraceID: TraceID(ctx), SpanID: SpanID(ctx), ParentSpanID: parentID}, true)
	var once sync.Once
	return ctx, func(reason string) {
		once.Do(func() {
			if reason != "" {
				clean := safeValue(reason, true)
				if clean == "" {
					r.reject(fields.UserID)
					clean = "diagnostic_reason_rejected"
				}
				span.SetAttributes(attribute.String("support.reason", clean))
				span.SetStatus(codes.Error, "")
			} else {
				span.SetStatus(codes.Ok, "")
			}
			span.End()
		})
	}
}

func (r *Recorder) Event(ctx context.Context, name string, fields Fields) {
	if r == nil || !r.enabled() {
		return
	}
	ctx = nonNil(ctx)
	fields, ok := r.fields(ctx, name, fields)
	if !ok {
		return
	}
	r.record(Event{Fields: fields, ID: randomID(), Timestamp: time.Now().UTC(), Name: name, Phase: "event", LaunchID: r.launchID, TraceID: TraceID(ctx), SpanID: SpanID(ctx)}, false)
}

func (r *Recorder) fields(ctx context.Context, name string, fields Fields) (Fields, bool) {
	parent, _ := ctx.Value(contextFields{}).(Fields)
	clean := cleanFields(fields)
	// A nested operation cannot transfer inherited identifiers to another owner.
	if parent.UserID != "" && fields.UserID != "" && parent.UserID != fields.UserID {
		r.reject(parent.UserID)
		return Fields{}, false
	}
	if fields.UserID != "" && clean.UserID == "" {
		return Fields{}, false
	}
	merged := mergeFields(parent, clean)
	if merged.UserID == "" || safeValue(name, true) == "" {
		r.reject(merged.UserID)
		return Fields{}, false
	}
	if fields != clean {
		r.reject(merged.UserID)
	}
	return merged, true
}

func (r *Recorder) enabled() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.closed
}

func (r *Recorder) reject(owner string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closed && owner != "" {
		r.journal.drop(owner, 1)
	}
}

func (r *Recorder) record(event Event, durable bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closed {
		r.journal.append(event, durable)
	}
}

func (r *Recorder) Snapshot(userID string, from, to time.Time) (Snapshot, error) {
	if r == nil {
		return Snapshot{Events: []Event{}, Coverage: Coverage{Status: "unavailable"}}, nil
	}
	if userID == "" || safeValue(userID, false) != userID {
		return Snapshot{Events: []Event{}, Coverage: Coverage{Status: "unavailable"}}, errors.New("invalid support trace owner")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.journal.snapshot(userID, from, to)
}

func (r *Recorder) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	err := r.journal.sync()
	r.mu.Unlock()
	return errors.Join(err, r.provider.Shutdown(nonNil(ctx)))
}

func nonNil(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}

func randomID() string {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		// SDK trace IDs still identify the operation if the platform RNG fails.
		return "unavailable"
	}
	return hex.EncodeToString(id[:])
}
