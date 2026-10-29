package textreplay

import (
	"time"

	"infinite-canvas/backend/internal/model"
)

const (
	MaxEventBytes    = 64 << 10
	MaxTaskBytes     = 2 << 20
	MaxUserBytes     = 64 << 20
	MaxTaskEvents    = int64(4096)
	SuccessRetention = 24 * time.Hour
	DraftRetention   = 7 * 24 * time.Hour
	DeltaPageLimit   = 1000
	CacheTTL         = 750 * time.Millisecond
	cacheMaxEntries  = 256
	cacheMaxBytes    = 8 << 20
	cacheMaxLoads    = 8
	cacheLoadTimeout = 3 * time.Second
	cleanupInterval  = time.Hour
)

// Result is the public replay projection for HTTP and SSE.
type Result struct {
	Deltas    []model.TaskTextDelta `json:"deltas"`
	TextDraft string                `json:"textDraft,omitempty"`
	FinalText string                `json:"finalText,omitempty"`
	Complete  bool                  `json:"complete"`
	Status    model.TaskStatus      `json:"status"`
	Stage     string                `json:"stage,omitempty"`
	Progress  int                   `json:"progress"`
	Error     string                `json:"error,omitempty"`
}

type Limits struct {
	MaxTaskBytes  int64
	MaxUserBytes  int64
	MaxTaskEvents int64
}

func defaultLimits() Limits {
	return Limits{MaxTaskBytes: MaxTaskBytes, MaxUserBytes: MaxUserBytes, MaxTaskEvents: MaxTaskEvents}
}

type Stats struct {
	EventCount int64      `json:"eventCount"`
	TaskCount  int64      `json:"taskCount"`
	ByteCount  int64      `json:"byteCount"`
	OldestAt   *time.Time `json:"oldestAt,omitempty"`
}

func terminalStatus(status model.TaskStatus) bool {
	return status == model.TaskStatusSucceeded || status == model.TaskStatusFailed || status == model.TaskStatusCancelled
}
