package textreplay

import (
	"context"
	"time"

	"infinite-canvas/backend/internal/model"
)

// Store is the durable text-replay ledger. Every read and write carries the
// caller identity so a foreign user cannot observe or mutate another owner's
// increment window.
type Store interface {
	TaskForUser(userID, taskID string) (*model.Task, error)
	AppendDelta(userID, taskID, content string, expiresAt time.Time, limits Limits) (*model.TaskTextDelta, error)
	Deltas(userID, taskID string, after int64, limit int) ([]model.TaskTextDelta, error)
	Complete(userID, taskID, resultJSON string, now time.Time) (bool, error)
	Compact(taskID string, expiresAt time.Time, keepDraft bool) error
	Sweep(now time.Time) (int64, error)
	Stats() (Stats, error)
	WithContext(ctx context.Context) Store
}

// Logger records owner-scoped diagnostics. Failures here must not undo a
// completed archive write.
type Logger interface {
	Log(userID, taskID, level, message, payload string) error
}

type Dependencies struct {
	Logger Logger
	Now    func() time.Time
}

// API is the handler/root surface. Complete/Append/Read/Sweep/Finalize are
// the existing caller operations; CachedRead is the SSE hot path.
type API interface {
	Append(userID, taskID, content string) (*model.TaskTextDelta, error)
	Read(userID, taskID string, after int64) (*Result, error)
	CachedRead(ctx context.Context, userID, taskID string, after int64) (*Result, error)
	Complete(userID, taskID, text string) (*model.Task, error)
	Sweep() (int64, error)
	Finalize(taskID string, status model.TaskStatus) error
	Stats() (Stats, error)
	IsRequest(input map[string]any) bool
}
