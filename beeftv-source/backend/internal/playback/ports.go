package playback

import (
	"context"

	"infinite-canvas/backend/internal/model"
)

const (
	DirName         = "playback"
	CodecH264       = "h264"
	CodecH265       = "h265"
	CodecAV1        = "av1"
	CodecVP9        = "vp9"
	CodecMPEG4      = "mpeg4"
	PersistAttempts = 3
	probeMaxMoov    = 128 << 20
)

// Store is the durable playback-status port. Adapters wrap the existing
// resource repository; this package never opens a second ledger.
// Outcome writes are field-level and require the claimed processing row
// to still be READY-owned, so a concurrent delete cannot be resurrected.
type Store interface {
	ResourceForUser(userID, id string) (*model.Resource, error)
	ClaimPlaybackTranscode(id string) (bool, error)
	ReleasePlaybackTranscodeClaim(id string) error
	FinishPlaybackTranscode(id, status, objectKey, errText string) (bool, error)
	MarkPlaybackNone(id string) (bool, error)
	ResetStuckPlaybackTranscodes() error
}

// Runner starts background transcode on the runtime-owned worker.
// Go reports whether that owner accepted the work. A false result means
// the caller must release the claim; there is no fallback goroutine.
// fn receives the worker cancellation context.
type Runner interface {
	Go(fn func(context.Context)) bool
}

// Deps constructs the playback domain. DataDir is the workspace root.
// Context is the runtime-owned cancellation scope for transcodes and for
// refusing new claims during Stop. Lead injects worker.Context().
type Deps struct {
	DataDir        string
	Store          Store
	Runner         Runner
	Context        context.Context
	RuntimeContext func() context.Context
	LookPath       func(file string) (string, error)
	Transcode      func(ctx context.Context, src, dst string) error
}
