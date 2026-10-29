package editing

import (
	"context"
	"io"
)

// SourceOpener opens authorized bytes for an opaque plan source id.
// Callers resolve workspace ownership; this package never accepts native paths.
type SourceOpener interface {
	Open(ctx context.Context, sourceID string) (io.ReadCloser, error)
}

// Progress reports native render stages owned by this package. A nil Progress is ignored.
type Progress func(stage string, percent int) error
