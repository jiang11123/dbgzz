package supporttrace

import (
	"context"
	"encoding/binary"
	"math/rand/v2"

	"go.opentelemetry.io/otel/trace"
)

type desiredTraceID struct{}

// WithTraceID connects detached work to a stored W3C trace ID without inventing
// a parent span. The SDK uses this hint only when starting a new root; a real
// parent span context always takes precedence.
func WithTraceID(ctx context.Context, value string) context.Context {
	ctx = nonNil(ctx)
	id, err := trace.TraceIDFromHex(value)
	if err != nil || !id.IsValid() {
		return ctx
	}
	return context.WithValue(ctx, desiredTraceID{}, id)
}

// Like the SDK default, generated identifiers are random and non-zero. They
// identify diagnostics and are never authentication or authorization tokens.
type localIDGenerator struct{}

func (g localIDGenerator) NewIDs(ctx context.Context) (trace.TraceID, trace.SpanID) {
	id, _ := ctx.Value(desiredTraceID{}).(trace.TraceID)
	for !id.IsValid() {
		binary.NativeEndian.PutUint64(id[:8], rand.Uint64())
		binary.NativeEndian.PutUint64(id[8:], rand.Uint64())
	}
	return id, g.NewSpanID(ctx, id)
}

func (localIDGenerator) NewSpanID(context.Context, trace.TraceID) trace.SpanID {
	var id trace.SpanID
	for !id.IsValid() {
		binary.NativeEndian.PutUint64(id[:], rand.Uint64())
	}
	return id
}
