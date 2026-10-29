package app

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/provider/workflow"
)

func TestRejectedModelSubmissionSurvivesPersistenceWithoutRetryLock(t *testing.T) {
	s, task := workflowPaidTaskFixture(t)
	cause := generation.UncertainVideoSubmission(context.Background(), generation.HTTPError{
		StatusCode: http.StatusServiceUnavailable,
		Body:       `{"error":{"code":"model_not_found","message":"分组 企业 下模型 grok-imagine-video-1.5 无可用渠道（distributor）"}}`,
	})
	_ = s.terminalCoordinator().handleExecutionFailure(&task, cause, false, false)
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.TaskStatusFailed || stored.Stage == "submission_unknown" || persistedFailureBlocksRetry(stored.Error, stored.Stage) {
		t.Fatalf("explicit rejection remained uncertain: %+v", stored)
	}
	if code := taskForOutput(*stored).ErrorCode; code != "provider_unavailable" {
		t.Fatalf("code = %q", code)
	}
}

func TestUnsentVideoFailureSurvivesPersistenceWithoutRetryLock(t *testing.T) {
	s, task := workflowPaidTaskFixture(t)
	task.FailureDiagnostics = &model.TaskFailureDiagnostics{Requests: []model.TaskRequestEvidence{{
		Operation: "submit", Method: "POST", Outcome: "not_dispatched", TransportPhase: "tls", TransportRoute: "direct",
	}}}
	cause := generation.UncertainVideoSubmission(context.Background(), generation.RequestNotSentError{Cause: context.DeadlineExceeded})
	if err := s.terminalCoordinator().handleExecutionFailure(&task, cause, false, false); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Stage == "submission_unknown" || persistedFailureBlocksRetry(stored.Error, stored.Stage) {
		t.Fatalf("unsent task remained locked: %+v", stored)
	}
	for _, code := range []string{taskSummaryForOutput(*stored).ErrorCode, taskForOutput(*stored).ErrorCode} {
		if code != "request_not_sent" {
			t.Fatalf("restored code = %q", code)
		}
	}
	d := taskSummaryForOutput(*stored).FailureDiagnostics
	if d == nil || len(d.Requests) != 1 || d.Requests[0].TransportPhase != "tls" || d.Requests[0].TransportRoute != "direct" {
		t.Fatalf("transport evidence lost: %+v", d)
	}
}

func TestLegacyUnknownSubmissionStillRequiresProof(t *testing.T) {
	// A legacy error string does not tell us whether a previous redirect or
	// attempt reached the service. Do not unlock it merely by matching TLS text.
	if !persistedFailureBlocksRetry("Post: net/http: TLS handshake timeout", "submission_unknown") {
		t.Fatal("legacy task unlocked without transport evidence")
	}
}

func TestWorkflowPreservesConfirmedUnsentCreate(t *testing.T) {
	err := (&Service{}).fenceWorkflowSubmission(context.Background(), workflow.Input{}, workflow.CreateUncertain{
		Err: generation.RequestNotSentError{Cause: context.DeadlineExceeded},
	})
	failure := generation.ClassifyError(err)
	var unknown generation.SubmissionUnknownError
	if errors.As(err, &unknown) || failure.Category != generation.CategoryRequestNotSent || failure.BlocksAutomaticRetry() {
		t.Fatalf("workflow lost unsent evidence: err=%v failure=%+v", err, failure)
	}
}
