package app

import (
	"context"
	"log"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/playback"
	"infinite-canvas/backend/internal/repository"
)

func (s *Service) playbackRuntime() *playback.Service {
	if s == nil {
		return playback.New(playback.Deps{})
	}
	s.playbackOnce.Do(func() {
		runner := playbackRunner{svc: s}
		s.playback = playback.New(playback.Deps{
			DataDir:        s.dataDir,
			Store:          playbackStore{repo: s.repo},
			Runner:         runner,
			RuntimeContext: runner.Context,
		})
	})
	return s.playback
}

type playbackStore struct {
	repo *repository.Repository
}

func (s playbackStore) PlaybackCopiesForUser(userID string) ([]model.Resource, error) {
	return s.repo.PlaybackCopiesForUser(userID)
}

func (s playbackStore) ResetPlaybackCopy(userID, id, objectKey string) error {
	return s.repo.ResetPlaybackCopy(userID, id, objectKey)
}

func (s playbackStore) ResourceForUser(userID, id string) (*model.Resource, error) {
	if s.repo == nil {
		return nil, nil
	}
	return s.repo.ResourceForUser(userID, id)
}

func (s playbackStore) ClaimPlaybackTranscode(id string) (bool, error) {
	if s.repo == nil {
		return false, nil
	}
	return s.repo.ClaimPlaybackTranscode(id)
}

func (s playbackStore) ReleasePlaybackTranscodeClaim(id string) error {
	if s.repo == nil {
		return nil
	}
	return s.repo.ReleasePlaybackTranscodeClaim(id)
}

func (s playbackStore) FinishPlaybackTranscode(id, status, objectKey, errText string) (bool, error) {
	if s.repo == nil {
		return false, nil
	}
	return s.repo.FinishPlaybackTranscode(id, status, objectKey, errText)
}

func (s playbackStore) MarkPlaybackNone(id string) (bool, error) {
	if s.repo == nil {
		return false, nil
	}
	return s.repo.MarkPlaybackNone(id)
}

func (s playbackStore) ResetStuckPlaybackTranscodes() error {
	if s.repo == nil {
		return nil
	}
	return s.repo.ResetStuckPlaybackTranscodes()
}

type playbackRunner struct {
	svc *Service
}

func (r playbackRunner) Go(fn func(context.Context)) bool {
	if r.svc == nil || fn == nil {
		return false
	}
	ctx := r.Context()
	if ctx == nil {
		return false
	}
	return r.svc.runWorkerTask(func() { fn(ctx) })
}

func (r playbackRunner) Context() context.Context {
	if r.svc == nil {
		return nil
	}
	r.svc.workerRuntimeMu.Lock()
	w := r.svc.workers
	r.svc.workerRuntimeMu.Unlock()
	if w == nil {
		return nil
	}
	return w.Context()
}

func logPlaybackRecovery(err error) {
	if err != nil {
		log.Printf("playback recovery: %v", err)
	}
}
