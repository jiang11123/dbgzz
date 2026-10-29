package textreplay

import (
	"context"
	"errors"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

var ErrNotFound = gorm.ErrRecordNotFound

type repoStore struct{ repo *repository.Repository }

func NewStore(repo *repository.Repository) Store {
	return repoStore{repo: repo}
}

func (s repoStore) TaskForUser(userID, taskID string) (*model.Task, error) {
	if s.repo == nil {
		return nil, errors.New("text replay store is not initialized")
	}
	return s.repo.TaskForUser(userID, taskID)
}

func (s repoStore) AppendDelta(userID, taskID, content string, expiresAt time.Time, limits Limits) (*model.TaskTextDelta, error) {
	if s.repo == nil {
		return nil, errors.New("text replay store is not initialized")
	}
	return s.repo.AppendTaskTextDelta(userID, taskID, content, expiresAt, repository.TextReplayLimits{
		MaxTaskBytes: limits.MaxTaskBytes, MaxUserBytes: limits.MaxUserBytes, MaxTaskEvents: limits.MaxTaskEvents,
	})
}

func (s repoStore) Deltas(userID, taskID string, after int64, limit int) ([]model.TaskTextDelta, error) {
	if s.repo == nil {
		return nil, errors.New("text replay store is not initialized")
	}
	return s.repo.TaskTextDeltas(userID, taskID, after, limit)
}

func (s repoStore) Complete(userID, taskID, resultJSON string, now time.Time) (bool, error) {
	if s.repo == nil {
		return false, errors.New("text replay store is not initialized")
	}
	return s.repo.CompleteTextReplayTask(userID, taskID, resultJSON, now)
}

func (s repoStore) Compact(taskID string, expiresAt time.Time, keepDraft bool) error {
	if s.repo == nil {
		return errors.New("text replay store is not initialized")
	}
	err := s.repo.CompactTaskTextDeltas(taskID, expiresAt, keepDraft)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrNotFound
	}
	return err
}

func (s repoStore) Sweep(now time.Time) (int64, error) {
	if s.repo == nil {
		return 0, errors.New("text replay store is not initialized")
	}
	return s.repo.CleanupTaskTextDeltas(now)
}

func (s repoStore) Stats() (Stats, error) {
	if s.repo == nil {
		return Stats{}, errors.New("text replay store is not initialized")
	}
	raw, err := s.repo.TextReplayStats()
	if err != nil {
		return Stats{}, err
	}
	return Stats{EventCount: raw.EventCount, TaskCount: raw.TaskCount, ByteCount: raw.ByteCount, OldestAt: raw.OldestAt}, nil
}

func (s repoStore) WithContext(ctx context.Context) Store {
	if s.repo == nil {
		return s
	}
	return repoStore{repo: s.repo.WithContext(ctx)}
}
