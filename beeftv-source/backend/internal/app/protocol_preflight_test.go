package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func TestMissingProtocolFailsBeforeGenerationDispatch(t *testing.T) {
	for _, mode := range []string{"image", "audio"} {
		t.Run(mode, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				w.WriteHeader(http.StatusInternalServerError)
			}))
			t.Cleanup(server.Close)
			input, err := json.Marshal(map[string]any{
				"mode": mode, "prompt": "local preflight fixture",
				"config": map[string]any{"baseUrl": server.URL, "apiKey": "synthetic", "model": "fixture", "interfaceType": "uninstalled-protocol-fixture"},
			})
			if err != nil {
				t.Fatal(err)
			}
			expires := time.Now().Add(time.Hour)
			task := model.Task{ID: "missing-protocol-" + mode, UserID: "user", Type: "canvas_" + mode, Status: model.TaskStatusRunning, Attempts: 1, InputJSON: string(input), LeaseOwner: "owner", LeaseExpiresAt: &expires}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			attempt, err := s.beginTaskRouteAttempt(&task)
			if err != nil {
				t.Fatal(err)
			}
			result, err := s.routeExecutor().execute(context.Background(), &task, attempt)
			if err != nil {
				t.Fatal(err)
			}
			var preparation generation.RequestPreparationError
			if !errors.As(result.err, &preparation) || !strings.Contains(preparation.Error(), "uninstalled-protocol-fixture 未安装") || isImageRecoveryError(result.err) {
				t.Fatalf("missing protocol was not preserved as a local preparation failure: %v", result.err)
			}
			if requests.Load() != 0 {
				t.Fatalf("preflight sent %d HTTP requests", requests.Load())
			}
			storedAttempt, err := s.repo.LatestRouteAttempt(task.ID)
			if err != nil || storedAttempt.DispatchState != "rejected_no_job" || storedAttempt.FailureCode != "request_not_sent" {
				t.Fatalf("local rejection receipt = %+v, err=%v", storedAttempt, err)
			}
			if !strings.Contains(storedAttempt.FailureMessage, "uninstalled-protocol-fixture 未安装") {
				t.Fatalf("lost first failure: %q", storedAttempt.FailureMessage)
			}
			if err := s.terminalCoordinator().handleExecutionFailure(&task, result.err, false, false); err == nil {
				t.Fatal("missing terminal error")
			}
			stored, err := s.repo.Task(task.ID)
			if err != nil || stored.Status != model.TaskStatusFailed || stored.Stage != taskStageRequestNotSent || persistedFailureBlocksRetry(stored.Error, stored.Stage) || persistedFailureErrorCode(stored.Error, stored.Stage) != "request_not_sent" {
				t.Fatalf("local failure incorrectly blocks manual retry: %+v, err=%v", stored, err)
			}
			if err := s.validateImageTaskRetry(stored); err != nil {
				t.Fatalf("unsubmitted image blocked by recovery guard: %v", err)
			}
			var submissions int64
			if err := db.Model(&model.ImageSubmission{}).Where("task_id = ?", task.ID).Count(&submissions).Error; err != nil || submissions != 0 {
				t.Fatalf("submission records=%d, err=%v", submissions, err)
			}
			var logs []model.ApiCallLog
			if err := db.Where("task_id = ?", task.ID).Find(&logs).Error; err != nil || len(logs) != 1 || logs[0].Method != "INTERNAL" || logs[0].ErrorCode != "request_not_sent" {
				t.Fatalf("preflight audit = %+v, err=%v", logs, err)
			}
		})
	}
}

func TestProtocolPreflightDoesNotUnsealPriorSubmission(t *testing.T) {
	local := generation.ProtocolPreparationError{Cause: errors.New("接口类型 fixture 未安装")}
	for _, cause := range []error{
		imageRecoveryError{local},
		generation.SubmissionUnknownError{Cause: local},
		errors.New("接口类型 fixture 未安装"), // Text from an unknown execution is not dispatch evidence.
	} {
		if safeRouteRejection(cause) || routeFailureCode(cause) != "submission_unknown" {
			t.Fatalf("unproven rejection became safe: %T %v", cause, cause)
		}
	}
}

func TestMissingProtocolForExistingProviderTaskIsNotUnsubmitted(t *testing.T) {
	ctx := generation.WithRuntime(context.Background(), generation.Runtime{Call: generation.CallMeta{ProviderRequestID: "already-accepted"}})
	_, err := generation.Execute(ctx, generation.Input{Mode: "audio", Prompt: "fixture", Config: generation.Config{
		BaseURL: "https://unused.invalid", APIKey: "synthetic", Model: "fixture", InterfaceType: "uninstalled-protocol-fixture",
	}})
	var preparation generation.RequestPreparationError
	if err == nil || errors.As(err, &preparation) || safeRouteRejection(err) || routeFailureCode(err) != "submission_unknown" {
		t.Fatalf("existing provider task lost submission evidence: %v", err)
	}
}
