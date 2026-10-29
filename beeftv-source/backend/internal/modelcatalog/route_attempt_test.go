package modelcatalog

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestDecideExistingAttempt(t *testing.T) {
	image := ImageSubmissionView{Found: true}
	task := &model.Task{Type: "canvas_image", LogicalModelID: "lm"}
	if got := DecideExistingAttempt(task, nil, image); got.Action != AttemptCreateSelected {
		t.Fatalf("empty attempts action = %v", got.Action)
	}
	direct := &model.Task{Type: "canvas_image"}
	if got := DecideExistingAttempt(direct, nil, image); got.Action != AttemptCreateDirect {
		t.Fatalf("direct action = %v", got.Action)
	}
	notSent := []model.RouteAttempt{{DispatchState: "not_sent"}}
	if got := DecideExistingAttempt(task, notSent, ImageSubmissionView{}); got.Action != AttemptReuse {
		t.Fatalf("not_sent action = %v", got.Action)
	}
	accepted := []model.RouteAttempt{{DispatchState: "accepted", ProviderRequestID: "up"}}
	if got := DecideExistingAttempt(task, accepted, image); got.Action != AttemptReuse {
		t.Fatalf("image accepted with submission action = %v", got.Action)
	}
	unknown := []model.RouteAttempt{{DispatchState: "submission_unknown"}}
	if got := DecideExistingAttempt(task, unknown, ImageSubmissionView{}); got.Action != AttemptUncertain {
		t.Fatalf("unknown without id action = %v", got.Action)
	}
	rejectedImage := []model.RouteAttempt{{DispatchState: "rejected_no_job", FailureCode: "image_throttled", AttemptNumber: 1}}
	if got := DecideExistingAttempt(task, rejectedImage, ImageSubmissionView{}); got.Action != AttemptRetryImage {
		t.Fatalf("image throttle action = %v", got.Action)
	}
	rejectedText := []model.RouteAttempt{{DispatchState: "rejected_no_job"}}
	textTask := &model.Task{Type: "canvas_text", LogicalModelID: "lm"}
	if got := DecideExistingAttempt(textTask, rejectedText, ImageSubmissionView{}); got.Action != AttemptSwitchRoute {
		t.Fatalf("text rejected action = %v", got.Action)
	}
}

func TestShouldSwitchRouteAfterFailure(t *testing.T) {
	task := &model.Task{LogicalModelID: "lm", Type: "canvas_text"}
	attempt := &model.RouteAttempt{DispatchState: "rejected_no_job"}
	if !ShouldSwitchRouteAfterFailure(task, attempt, FailureInfo{}) {
		t.Fatal("rejected logical route should switch")
	}
	if ShouldSwitchRouteAfterFailure(task, attempt, FailureInfo{Canceled: true}) {
		t.Fatal("canceled failure switched routes")
	}
	image := &model.Task{LogicalModelID: "lm", Type: "canvas_image"}
	if ShouldSwitchRouteAfterFailure(image, attempt, FailureInfo{StatusCode: 400}) {
		t.Fatal("image permanent errors must not switch routes")
	}
}

func TestIsDispatchUncertain(t *testing.T) {
	if !IsDispatchUncertain(DispatchUncertainError{Message: "stop"}) {
		t.Fatal("typed uncertain error not detected")
	}
	if IsDispatchUncertain(errors.New("other")) {
		t.Fatal("plain error treated as uncertain")
	}
}
