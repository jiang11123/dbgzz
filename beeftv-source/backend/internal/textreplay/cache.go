package textreplay

import (
	"context"
	"errors"
	"sync"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
)

type cacheKey struct {
	userID, taskID string
	after          int64
}

type replayCache struct {
	once  sync.Once
	inner *platform.BoundedReadCache[cacheKey, *Result]
}

func (s *Service) initCache() {
	s.cache.once.Do(func() {
		s.cache.inner = platform.NewBoundedReadCache[cacheKey, *Result](cacheMaxEntries, cacheMaxBytes, cacheMaxLoads, CacheTTL)
	})
}

func (s *Service) ClearCache() {
	if s == nil {
		return
	}
	s.initCache()
	s.cache.inner.Clear()
}

// CachedRead is SSE display only. The key includes user, task, and cursor so
// reconnects do not inherit another client's already-consumed window. Source
// reads still check ownership. Callers receive a copy so they cannot mutate
// another connection's increments.
func (s *Service) CachedRead(ctx context.Context, userID, taskID string, after int64) (*Result, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("text replay store is not initialized")
	}
	s.initCache()
	ctx, cancel := context.WithTimeout(ctx, cacheLoadTimeout)
	defer cancel()
	value, err := s.cache.inner.Get(ctx, cacheKey{userID, taskID, after}, func(ctx context.Context) (*Result, int, error) {
		reader := &Service{store: s.store.WithContext(ctx), deps: s.deps}
		value, err := reader.Read(userID, taskID, after)
		if err != nil {
			return nil, 0, err
		}
		bytes := 512 + len(value.TextDraft) + len(value.FinalText) + len(value.Error) + len(value.Stage)
		for _, delta := range value.Deltas {
			bytes += 256 + len(delta.Content) + len(delta.ID) + len(delta.UserID) + len(delta.TaskID)
		}
		return value, bytes, nil
	})
	if errors.Is(err, platform.ErrReadCacheBusy) {
		return nil, &kernel.AppError{Status: 503, Code: 503, Message: "任务状态查询繁忙，请稍后重试", Retryable: true}
	}
	if err != nil {
		return nil, err
	}
	copy := *value
	copy.Deltas = append([]model.TaskTextDelta(nil), value.Deltas...)
	return &copy, nil
}
