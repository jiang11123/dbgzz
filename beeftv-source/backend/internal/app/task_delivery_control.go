package app

import (
	"context"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskdelivery"
)

const generationDownloadTimeout = 15 * time.Minute

func deliveryPaused(stage string) bool {
	return stage == "delivery_paused" || stage == "delivery_timed_out"
}

// The generation stays succeeded: pausing delivery must never enqueue another
// paid generation or ask the provider to cancel an already finished job.
func (s *Service) pauseGenerationDownload(task model.Task, stage string) (*model.Task, error) {
	s.deliveryControlMu.Lock()
	defer s.deliveryControlMu.Unlock()
	stored, err := s.generationDeliverer().LoadedOutputs(task.ID)
	if err != nil {
		return nil, err
	}
	if localtask.DeliveryComplete(task.ResultJSON, stored, task.Type) {
		return nil, BadAuthRequest("生成结果已取回")
	}
	// Claim the task's write before rechecking results. A final delivery commit
	// either precedes this transaction (and wins here) or follows it (and clears
	// the pause in CommitOwned); it cannot slip between this read and write.
	if err := s.repo.Transaction(func(tx *repository.Repository) error {
		if err := tx.SetGenerationDeliveryStage(task.UserID, task.ID, stage); err != nil {
			return err
		}
		rows, err := tx.GenerationOutputResults(task.ID)
		if err != nil {
			return err
		}
		outputs, err := taskdelivery.DecodeStoredOutputs(rows)
		if err != nil {
			return err
		}
		if localtask.DeliveryComplete(task.ResultJSON, outputs, task.Type) {
			stage = "生成完成"
			return tx.SetGenerationDeliveryStage(task.UserID, task.ID, stage)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	for identity, cancel := range s.deliveryCancels {
		if strings.HasPrefix(identity, task.ID+":") {
			cancel()
		}
	}
	for identity := range s.deliveryDeadlines {
		if strings.HasPrefix(identity, task.ID+":") {
			delete(s.deliveryDeadlines, identity)
		}
	}
	task.Stage = stage
	s.attachTaskDelivery(&task)
	return &task, nil
}

func (s *Service) resumeGenerationDownload(task model.Task) (*model.Task, error) {
	s.deliveryControlMu.Lock()
	defer s.deliveryControlMu.Unlock()
	if s.deliveryClosed || s.IsDraining() {
		return nil, &kernel.AppError{Status: kernel.CodeUnavailable, Code: kernel.CodeUnavailable, Message: localtask.DrainRetryMessage, Retryable: true}
	}
	for identity := range s.deliveryCancels {
		if strings.HasPrefix(identity, task.ID+":") {
			return nil, errors.New("正在停止取回，请稍后再试")
		}
	}
	if err := s.repo.SetGenerationDeliveryStage(task.UserID, task.ID, "正在取回结果"); err != nil {
		return nil, err
	}
	task.Stage = "正在取回结果"
	// The recovery worker owns the download; this request only removes the pause.
	s.attachTaskDelivery(&task)
	return &task, nil
}

func (s *Service) beginGenerationDownload(userID, identity string, timeout time.Duration) (context.Context, func(error), error) {
	s.deliveryControlMu.Lock()
	if s.deliveryClosed || s.IsDraining() {
		s.deliveryControlMu.Unlock()
		return nil, nil, context.Canceled
	}
	s.deliveryControlMu.Unlock()
	taskID, _, ok := strings.Cut(identity, ":")
	if !ok {
		return nil, nil, errors.New("generation delivery identity is invalid")
	}
	task, err := s.repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, nil, err
	}
	if task.Status != model.TaskStatusSucceeded || deliveryPaused(task.Stage) {
		return nil, nil, context.Canceled
	}
	parent := s.backgroundWorkers().Context()
	if parent == nil {
		parent = context.Background()
	}
	// Persist the start checkpoint before opening the download's time budget.
	// Diagnostic I/O must not consume a new delivery deadline before work begins.
	parent, finishTrace := s.SupportTrace().Start(taskSupportContext(parent, *task), "generation.download", taskSupportFields(*task))
	s.deliveryControlMu.Lock()
	// A pause or shutdown may have happened while the checkpoint was saved.
	current, readErr := s.repo.TaskForUser(userID, taskID)
	if readErr != nil || s.deliveryClosed || s.IsDraining() || current.Status != model.TaskStatusSucceeded || deliveryPaused(current.Stage) {
		s.deliveryControlMu.Unlock()
		if readErr == nil {
			readErr = context.Canceled
		}
		finishTrace("download_not_started")
		return nil, nil, readErr
	}
	if s.deliveryDeadlines == nil {
		s.deliveryDeadlines = map[string]time.Time{}
	}
	deadline, exists := s.deliveryDeadlines[identity]
	if !exists {
		deadline = time.Now().Add(timeout)
		s.deliveryDeadlines[identity] = deadline
	}
	ctx, cancel := context.WithDeadline(parent, deadline)
	if s.deliveryCancels == nil {
		s.deliveryCancels = map[string]context.CancelFunc{}
	}
	s.deliveryCancels[identity] = cancel
	s.deliveryControlMu.Unlock()
	return ctx, func(downloadErr error) {
		reason := supportFailureReason(downloadErr)
		if downloadErr != nil && ctx.Err() != nil {
			reason = supportFailureReason(ctx.Err())
		}
		defer finishTrace(reason)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			_, _ = s.pauseGenerationDownload(*task, "delivery_timed_out")
		}
		cancel()
		s.deliveryControlMu.Lock()
		delete(s.deliveryCancels, identity)
		if downloadErr == nil {
			delete(s.deliveryDeadlines, identity)
		}
		s.deliveryControlMu.Unlock()
	}, nil
}

func (s *Service) stopGenerationDownloads() {
	s.deliveryControlMu.Lock()
	defer s.deliveryControlMu.Unlock()
	s.deliveryClosed = true
	for _, cancel := range s.deliveryCancels {
		cancel()
	}
}
