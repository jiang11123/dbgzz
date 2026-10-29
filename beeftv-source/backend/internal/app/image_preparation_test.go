package app

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func TestImagePreparationFailureIsNotUnknownSubmission(t *testing.T) {
	s, db, task, _, _ := imageSubmissionFixture(t, false)
	if err := db.Migrator().DropTable(&model.ImageSubmission{}); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(generation.WithImageReplayProtocol(context.Background(), generation.ImageReplayProtocol), imageTaskContext{}, task)
	ctx = context.WithValue(ctx, imageAttemptContext{}, "image-attempt")
	ctx = context.WithValue(ctx, providerSubmissionKeyContext{}, "persisted-key")
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://beeftv.app/v1/images/generations", strings.NewReader(`{}`))
	_, _, _, err := (appImagePort{s}).Intercept(req)
	var preparation imagePreparationError
	if !errors.As(err, &preparation) {
		t.Fatalf("expected preparation error: %v", err)
	}
	failure := classifyTaskFailure(err)
	if failure.Uncertain || failure.Category == generation.CategorySubmissionUncertain || !strings.Contains(failure.Reason, "尚未提交") {
		t.Fatalf("misclassified local failure: %#v", failure)
	}
	unknown := classifyTaskFailure(imageRecoveryError{context.DeadlineExceeded})
	if !unknown.Uncertain || unknown.Category != generation.CategorySubmissionUncertain {
		t.Fatalf("lost-response safety changed: %#v", unknown)
	}
	sealed := classifyTaskFailure(imageRecoveryError{imagePreparationError{errors.New("database is locked")}})
	if !sealed.Uncertain || sealed.Category != generation.CategorySubmissionUncertain || strings.Contains(sealed.Reason, "尚未提交") {
		t.Fatalf("a sealed prior attempt was described as unsubmitted: %#v", sealed)
	}
}

// A failed metadata GET never dispatched the paid image POST. Route sealing
// must preserve that proof rather than wrap it as an unknown submission.
func TestImageReplayProbeFailureRemainsUnsentAfterRouteFinish(t *testing.T) {
	s, task, attempt := routeUnknownFixture(t)
	task.Type = "canvas_image"
	cause := generation.RequestPreparationError{Cause: generation.RequestNotSentError{Cause: context.DeadlineExceeded}}
	s.finishTaskRouteAttempt(attempt, &task, cause)
	stored, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil || stored.DispatchState != "rejected_no_job" {
		t.Fatalf("metadata probe sealed as unknown: %+v %v", stored, err)
	}
	failure := classifyTaskFailure(cause)
	if failure.Uncertain || failure.Category != generation.CategoryRequestNotSent {
		t.Fatalf("incorrect UI failure: %#v", failure)
	}
}
