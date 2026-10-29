package app

import (
	"context"
	"errors"
	"log"
	"sync"

	"infinite-canvas/backend/internal/assistantturns"
)

type assistantContinuationBackground struct {
	mu       sync.Mutex
	submit   func(context.Context, assistantturns.ContinuationView) error
	afterID  string
	inFlight map[string]bool
}

// SetAssistantContinuationSubmitter connects the application-owned scan to its
// owned Durable host. It must not depend on a browser or an active canvas.
func (s *Service) SetAssistantContinuationSubmitter(submit func(context.Context, assistantturns.ContinuationView) error) {
	s.continuationBackground.mu.Lock()
	s.continuationBackground.submit = submit
	s.continuationBackground.mu.Unlock()
}

func (s *Service) recoverAssistantContinuations(ctx context.Context) {
	background := &s.continuationBackground
	background.mu.Lock()
	submit, afterID := background.submit, background.afterID
	background.mu.Unlock()
	if submit == nil || ctx.Err() != nil || s.IsDraining() {
		return
	}
	rows, err := s.assistantTurnsOrInit().PendingContinuations(afterID, 16)
	if err != nil {
		log.Printf("assistant continuation scan deferred: error_type=%T", err)
		return
	}
	nextAfter, exhausted := afterID, true
	for _, row := range rows {
		background.mu.Lock()
		if background.inFlight == nil {
			background.inFlight = map[string]bool{}
		}
		if background.inFlight[row.ID] {
			nextAfter = row.ID
			background.mu.Unlock()
			continue
		}
		if len(background.inFlight) >= 4 {
			exhausted = false
			background.mu.Unlock()
			break
		}
		background.inFlight[row.ID] = true
		nextAfter = row.ID
		background.mu.Unlock()
		release := func() {
			background.mu.Lock()
			delete(background.inFlight, row.ID)
			background.mu.Unlock()
		}
		if !s.runWorkerTask(func() {
			defer release()
			claimed, claimErr := s.ClaimAssistantContinuation(row.UserID, row.ID)
			if claimErr != nil {
				var expected *assistantturns.Error
				if !errors.As(claimErr, &expected) {
					log.Printf("assistant continuation claim deferred: id=%s error_type=%T", row.ID, claimErr)
				}
				return
			}
			if ctx.Err() != nil || claimed.State == "done" || claimed.State == "cancelled" {
				return
			}
			if err := submit(ctx, *claimed); err != nil && ctx.Err() == nil {
				// Unknown admission is retried only under this receipt's fixed
				// request/turn pair. The official host owns input deduplication.
				log.Printf("assistant continuation observer deferred: id=%s error_type=%T", row.ID, err)
			}
		}) {
			release()
		}
	}
	// Resume after the last visited receipt, not the fetched page: repeatedly
	// interrupted old observers must not starve the rest of a partial page.
	if exhausted && len(rows) < 16 {
		nextAfter = ""
	}
	background.mu.Lock()
	background.afterID = nextAfter
	background.mu.Unlock()
}
