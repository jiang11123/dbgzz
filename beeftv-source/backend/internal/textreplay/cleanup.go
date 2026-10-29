package textreplay

import (
	"context"
	"time"
)

// RunCleanupLoop sweeps expired increments on the existing hourly cadence.
// The caller owns process lifetime (app worker loop / composition root).
func (s *Service) RunCleanupLoop(ctx context.Context, every time.Duration, onErr func(error)) {
	if s == nil {
		return
	}
	if every <= 0 {
		every = cleanupInterval
	}
	cleanup := func() {
		if _, err := s.Sweep(); err != nil && onErr != nil {
			onErr(err)
		}
	}
	cleanup()
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cleanup()
		}
	}
}
