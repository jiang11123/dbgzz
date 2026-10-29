package app

import (
	"context"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

func routeUnknownFixture(t *testing.T) (*Service, model.Task, *model.RouteAttempt) {
	t.Helper()
	s, db := newTimelineTaskTestService(t)
	task := model.Task{ID: "task-route-unknown", UserID: "user", Type: "canvas_video", Status: model.TaskStatusRunning, LogicalModelID: "logical", RouteRun: 1, InputJSON: `{"mode":"video"}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	attempt := &model.RouteAttempt{ID: "attempt-route-unknown", TaskID: task.ID, LogicalModelID: task.LogicalModelID, RouteRun: task.RouteRun, AttemptNumber: 1, Status: "dispatching", DispatchState: "not_sent", StartedAt: time.Now()}
	if err := s.repo.CreateRouteAttempt(attempt); err != nil {
		t.Fatal(err)
	}
	return s, task, attempt
}

func TestUnknownRouteFailureDoesNotRecoverNestedRejectionEvidence(t *testing.T) {
	for _, kind := range []string{"preparation", "forbidden", "throttled", "slot", "not-sent", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			s, task, attempt := routeUnknownFixture(t)
			var cause error
			switch kind {
			case "preparation":
				cause = generation.RequestPreparationError{Cause: providerHTTPError{StatusCode: 503, Body: `{"error":{"code":"image_reference_upload_failed"}}`}}
			case "forbidden":
				cause = providerHTTPError{StatusCode: 403}
			case "throttled":
				cause = providerHTTPError{StatusCode: 429, RetryAfter: time.Minute}
			case "slot":
				_, _, cause = s.AcquireChannelSlot(context.Background(), "", "", time.Minute)
				if code, _ := ChannelSlotFailureDetails(cause); code == "" {
					t.Fatalf("expected real channel-slot error: %v", cause)
				}
			case "not-sent":
				cause = generation.RequestNotSentError{Cause: context.DeadlineExceeded}
			case "cancelled":
				cause = context.Canceled
			}
			unknown := generation.SubmissionUnknownError{Cause: cause}
			if info := routeFailureInfo(unknown); info != (modelcatalog.FailureInfo{}) {
				t.Fatalf("unknown wrapper leaked nested rejection: %+v", info)
			}
			s.finishTaskRouteAttempt(attempt, &task, unknown)
			stored, err := s.repo.LatestRouteAttempt(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stored.DispatchState != "submission_unknown" || stored.FailureCode != "submission_unknown" || stored.CompletedAt == nil {
				t.Fatalf("unknown route persisted as safe rejection: %+v", stored)
			}
			if next, err := s.nextRouteAttemptAfterFailure(&task, stored, unknown); err != nil || next != nil {
				t.Fatalf("unknown route attempted a fallback: next=%+v err=%v", next, err)
			}
			attempts, err := s.repo.RouteAttempts(task.ID, task.RouteRun)
			if err != nil || len(attempts) != 1 {
				t.Fatalf("unknown route created another attempt: count=%d err=%v", len(attempts), err)
			}
		})
	}
}

func TestIndependentPreparationRemainsRejectedNoJobForRoutes(t *testing.T) {
	s, task, attempt := routeUnknownFixture(t)
	cause := generation.RequestPreparationError{Cause: providerHTTPError{StatusCode: 503, Body: `{"error":{"code":"image_reference_upload_failed"}}`}}
	s.finishTaskRouteAttempt(attempt, &task, cause)
	stored, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.DispatchState != "rejected_no_job" || !modelcatalog.ShouldSwitchRouteAfterFailure(&task, stored, routeFailureInfo(cause)) {
		t.Fatalf("independent unsent failure lost its route rejection: %+v", stored)
	}
}
