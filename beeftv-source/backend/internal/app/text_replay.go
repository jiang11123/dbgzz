package app

import (
	"context"
	"log"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/textreplay"
)

type TextReplayResult = textreplay.Result

func isTextReplayTaskRequest(input map[string]any) bool {
	return textreplay.IsRequest(input)
}

func (s *Service) textReplayOrInit() *textreplay.Service {
	if s == nil {
		return nil
	}
	s.textReplayOnce.Do(func() {
		s.textReplay = textreplay.New(textreplay.NewStore(s.repo), textreplay.Dependencies{Logger: taskLogAdapter{s}})
	})
	return s.textReplay
}

// TextReplayLogger is the composition-root log port.
func (s *Service) TextReplayLogger() textreplay.Logger {
	if s == nil {
		return nil
	}
	return taskLogAdapter{s}
}

// TextReplay returns the archive owned by this runtime.
func (s *Service) TextReplay() *textreplay.Service {
	return s.textReplayOrInit()
}

func (s *Service) CompleteTextReplayTask(userID string, taskID string, text string) (*model.Task, error) {
	return s.textReplayOrInit().Complete(userID, taskID, text)
}

func (s *Service) AppendTaskTextDelta(userID string, taskID string, content string) (*model.TaskTextDelta, error) {
	return s.textReplayOrInit().Append(userID, taskID, content)
}

func (s *Service) TaskTextReplay(userID string, taskID string, after int64) (*TextReplayResult, error) {
	return s.textReplayOrInit().Read(userID, taskID, after)
}

func (s *Service) finalizeTaskTextReplay(taskID string, status model.TaskStatus) error {
	return s.textReplayOrInit().Finalize(taskID, status)
}

func (s *Service) CleanupTaskTextReplay() (int64, error) {
	return s.textReplayOrInit().Sweep()
}

func (s *Service) AdminTextReplayStats(actor *model.User) (textreplay.Stats, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return textreplay.Stats{}, err
	}
	return s.textReplayOrInit().Stats()
}

func (s *Service) startTextReplayCleanup(ctx context.Context) {
	replay := s.textReplayOrInit()
	s.runWorkerLoop(func(ctx context.Context) {
		replay.RunCleanupLoop(ctx, time.Hour, func(err error) {
			log.Printf("text replay cleanup failed: %v", err)
		})
	})
}
