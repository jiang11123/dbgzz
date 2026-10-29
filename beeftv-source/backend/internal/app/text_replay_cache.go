package app

import (
	"context"
	"time"

	"infinite-canvas/backend/internal/platform"
)

func (s *Service) initReadCaches() {
	s.readCachesOnce.Do(func() {
		s.concurrencyReadCache = platform.NewBoundedReadCache[string, platform.RuntimeTaskPolicy](1, 1024, 1, 2*time.Second)
		s.routeVersionReadCache = platform.NewBoundedReadCache[string, int64](1, 1024, 1, 250*time.Millisecond)
	})
}

// SSE 展示专用，不用于写路径和权限决策。回源仍检查任务归属。
func (s *Service) CachedTaskTextReplay(ctx context.Context, userID, taskID string, after int64) (*TextReplayResult, error) {
	s.initReadCaches()
	return s.textReplayOrInit().CachedRead(ctx, userID, taskID, after)
}
