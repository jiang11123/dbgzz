// Package supporttrace records bounded, local diagnostic evidence. Business
// tasks and the official assistant runtime remain the execution authorities.
package supporttrace

import "time"

// Fields contains only diagnostic identifiers and machine-readable outcomes.
// Request bodies, prompts, response bodies, credentials and media URLs do not
// belong in this record.
type Fields struct {
	UserID      string `json:"userId,omitempty"`
	RequestID   string `json:"requestId,omitempty"`
	TaskID      string `json:"taskId,omitempty"`
	CanvasID    string `json:"canvasId,omitempty"`
	NodeID      string `json:"nodeId,omitempty"`
	SessionID   string `json:"sessionId,omitempty"`
	TurnID      string `json:"turnId,omitempty"`
	OperationID string `json:"operationId,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

type Event struct {
	Fields
	ID           string    `json:"id"`
	Timestamp    time.Time `json:"timestamp"`
	Name         string    `json:"name"`
	Phase        string    `json:"phase"`
	LaunchID     string    `json:"launchId"`
	TraceID      string    `json:"traceId,omitempty"`
	SpanID       string    `json:"spanId,omitempty"`
	ParentSpanID string    `json:"parentSpanId,omitempty"`
	DurationMs   int64     `json:"durationMs,omitempty"`
	Status       string    `json:"status,omitempty"`
}

type Coverage struct {
	Status         string     `json:"status"`
	Records        int        `json:"records"`
	Dropped        int64      `json:"dropped"`
	WriteErrors    int64      `json:"writeErrors"`
	Bytes          int64      `json:"bytes"`
	From           *time.Time `json:"from,omitempty"`
	To             *time.Time `json:"to,omitempty"`
	RetentionHours int        `json:"retentionHours"`
	MaxBytes       int64      `json:"maxBytes"`
}

type Snapshot struct {
	Events   []Event  `json:"events"`
	Coverage Coverage `json:"coverage"`
}

type Source interface {
	Snapshot(userID string, from, to time.Time) (Snapshot, error)
}
