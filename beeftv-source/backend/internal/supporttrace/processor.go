package supporttrace

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// Sparse lifecycle spans go straight to the bounded local journal. There is no
// batch queue whose unexported records could disappear at process termination.
type localProcessor struct{ recorder *Recorder }

func (localProcessor) OnStart(context.Context, sdktrace.ReadWriteSpan) {}
func (localProcessor) Shutdown(context.Context) error                  { return nil }
func (localProcessor) ForceFlush(context.Context) error                { return nil }

func (p localProcessor) OnEnd(span sdktrace.ReadOnlySpan) {
	var fields Fields
	for _, attr := range span.Attributes() {
		value := attr.Value.AsString()
		switch attr.Key {
		case "support.user_id":
			fields.UserID = value
		case "support.request_id":
			fields.RequestID = value
		case "support.task_id":
			fields.TaskID = value
		case "support.canvas_id":
			fields.CanvasID = value
		case "support.node_id":
			fields.NodeID = value
		case "support.session_id":
			fields.SessionID = value
		case "support.turn_id":
			fields.TurnID = value
		case "support.operation_id":
			fields.OperationID = value
		case "support.reason":
			fields.Reason = value
		}
	}
	fields = cleanFields(fields)
	if fields.UserID == "" {
		return
	}
	name := safeValue(span.Name(), true)
	if name == "" {
		p.recorder.reject(fields.UserID)
		return
	}
	status := "ok"
	if span.Status().Code == codes.Error {
		status = "error"
	}
	parentID := ""
	if span.Parent().IsValid() {
		parentID = span.Parent().SpanID().String()
	}
	p.recorder.record(Event{
		Fields: fields, ID: randomID(), Timestamp: span.EndTime().UTC(), Name: name,
		Phase: "end", LaunchID: p.recorder.launchID, TraceID: span.SpanContext().TraceID().String(),
		SpanID: span.SpanContext().SpanID().String(), ParentSpanID: parentID,
		DurationMs: max(0, span.EndTime().Sub(span.StartTime()).Milliseconds()), Status: status,
	}, false)
}

func fieldAttributes(fields Fields) []attribute.KeyValue {
	return []attribute.KeyValue{
		attribute.String("support.user_id", fields.UserID), attribute.String("support.request_id", fields.RequestID),
		attribute.String("support.task_id", fields.TaskID), attribute.String("support.canvas_id", fields.CanvasID),
		attribute.String("support.node_id", fields.NodeID), attribute.String("support.session_id", fields.SessionID),
		attribute.String("support.turn_id", fields.TurnID), attribute.String("support.operation_id", fields.OperationID),
		attribute.String("support.reason", fields.Reason),
	}
}

var _ sdktrace.SpanProcessor = localProcessor{}
