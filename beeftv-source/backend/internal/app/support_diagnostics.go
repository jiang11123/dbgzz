package app

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/supporttrace"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskbinding"
)

// SupportTrace is owned by this workspace runtime, including its close barrier.
// Diagnostic storage failure never changes the business operation's result.
func (s *Service) SupportTrace() *supporttrace.Recorder {
	if s == nil {
		return nil
	}
	s.supportTraceOnce.Do(func() {
		if !s.IsLocalMode() || s.dataDir == "" || s.supportTraceClosed.Load() {
			return
		}
		s.supportTraceRecorder, s.supportTraceErr = supporttrace.New(filepath.Join(s.dataDir, "diagnostics"))
	})
	return s.supportTraceRecorder
}

func (s *Service) closeSupportTrace() {
	s.supportTraceClosed.Store(true)
	s.supportTraceOnce.Do(func() {})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = s.supportTraceRecorder.Close(ctx)
}

type runtimeTraceSource struct{ service *Service }

func (r runtimeTraceSource) Snapshot(userID string, from, to time.Time) (supporttrace.Snapshot, error) {
	recorder := r.service.SupportTrace()
	if r.service.supportTraceErr != nil {
		return supporttrace.Snapshot{Coverage: supporttrace.Coverage{Status: "failed", WriteErrors: 1}}, errors.New("diagnostic_store_unavailable")
	}
	return recorder.Snapshot(userID, from, to)
}

func taskSupportFields(task model.Task) supporttrace.Fields {
	fields := supporttrace.Fields{UserID: task.UserID, TaskID: task.ID, CanvasID: task.ProjectID, RequestID: task.RequestID}
	fields.NodeID = localtask.TargetBindingFromInput(task.InputJSON).NodeID
	if task.ClientOperationID != nil {
		fields.OperationID = *task.ClientOperationID
	}
	return fields
}

func taskSupportContext(ctx context.Context, task model.Task) context.Context {
	return supporttrace.WithTraceID(ctx, task.TraceID)
}

func supportFailureReason(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline_exceeded"
	}
	if errors.Is(err, context.Canceled) {
		return "context_cancelled"
	}
	var appErr *kernel.AppError
	if errors.As(err, &appErr) && appErr.Reason != "" {
		return string(appErr.Reason)
	}
	var bindingErr *taskbinding.Error
	if errors.As(err, &bindingErr) && bindingErr.Reason != "" {
		return bindingErr.Reason
	}
	var reason interface{ Reason() string }
	if errors.As(err, &reason) && reason.Reason() != "" {
		return reason.Reason()
	}
	return "operation_failed"
}
