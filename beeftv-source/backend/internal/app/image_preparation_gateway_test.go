package app

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func TestImageGatewayPreparationFailureDoesNotBecomeUnknownOrResend(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	calls := 0
	_, _, err := s.sendImageSubmissionWith(context.Background(), task, row, func(req *http.Request, admit func() error) ([]byte, string, error) {
		calls++
		if err := admit(); err != nil {
			return nil, "", err
		}
		return nil, "", generation.RequestPreparationError{Cause: providerHTTPError{StatusCode: 503, Body: `{"error":{"code":"image_reference_upload_failed","metadata":{"submission_state":"not_submitted"}}}`}}
	}, noImageWait)
	var preparation generation.RequestPreparationError
	if !errors.As(err, &preparation) || isImageRecoveryError(err) || calls != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
	failure := classifyTaskFailure(err)
	if failure.Uncertain || failure.Retryable || !failure.BlocksAutomaticRetry() || failure.Category != generation.CategoryProviderUnavailable || failure.Action != "请稍后重试" {
		t.Fatalf("preparation failure misclassified: %#v", failure)
	}
	attempt, readErr := s.repo.LatestRouteAttempt(task.ID)
	if readErr != nil {
		t.Fatal(readErr)
	}
	s.finishTaskRouteAttempt(attempt, &task, err)
	if attempt.DispatchState != "rejected_no_job" {
		t.Fatalf("dispatch=%s", attempt.DispatchState)
	}
	if retryErr := s.validateImageTaskRetry(&task); retryErr != nil {
		t.Fatalf("confirmed unsent task cannot be retried: %v", retryErr)
	}
	_ = s.terminalCoordinator().handleExecutionFailure(&task, err, false, false)
	stored, readErr := s.repo.Task(task.ID)
	if readErr != nil {
		t.Fatal(readErr)
	}
	output := taskForOutput(*stored)
	if output.Error != failure.UserMessage() || output.ErrorCode != "provider_unavailable" || generation.ClassifyText(output.Error).BlocksManualRetry() || generation.ClassifyText(output.Error).ProviderCode != "image_reference_upload_failed" {
		t.Fatalf("detail lost preparation proof: %+v", output)
	}
	summary := taskSummaryForOutput(*stored)
	if summary.Error != failure.UserMessage() || summary.ErrorCode != "provider_unavailable" {
		t.Fatalf("summary lost preparation proof: %+v", summary)
	}
	retried, retryErr := s.RetryTask(task.UserID, task.ID)
	if retryErr != nil || retried.ID != task.ID || retried.Status != model.TaskStatusQueued {
		t.Fatalf("confirmed unsent task manual retry failed: %+v %v", retried, retryErr)
	}
	if calls != 1 {
		t.Fatalf("manual requeue sent create without worker execution: %d", calls)
	}
	var count int64
	db.Model(&model.ImageSubmission{}).Where("task_id = ?", task.ID).Count(&count)
	if count != 1 {
		t.Fatalf("unexpected extra generation attempt: %d", count)
	}
}

func TestStoredReferencePreparationRetryStillHonorsUnknownStageAndReceipt(t *testing.T) {
	const message = "参考素材上传失败，本次尚未开始生成。请检查对象存储配置和公开读取权限后重试。"
	for _, state := range []string{"preparation", "unknown-stage", "unknown-receipt"} {
		t.Run(state, func(t *testing.T) {
			s, db, task, row, _ := imageSubmissionFixture(t, false)
			task.Status, task.Error, task.Stage = model.TaskStatusFailed, message, "参考素材上传失败"
			attempt, err := s.repo.LatestRouteAttempt(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			attempt.DispatchState = "rejected_no_job"
			if state == "unknown-stage" {
				task.Stage = "submission_unknown"
			}
			if state == "unknown-receipt" {
				attempt.DispatchState = "submission_unknown"
			}
			if err := db.Save(&task).Error; err != nil {
				t.Fatal(err)
			}
			if err := s.repo.SaveRouteAttempt(attempt); err != nil {
				t.Fatal(err)
			}
			if state == "preparation" {
				// Storage preparation can fail before any model HTTP request exists.
				if err := db.Delete(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			stored, err := s.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			detail, summary := taskForOutput(*stored), taskSummaryForOutput(*stored)
			if state == "unknown-stage" && (!generation.ClassifyText(detail.Error).Uncertain || !generation.ClassifyText(summary.Error).Uncertain) {
				t.Fatalf("unknown stage leaked an unsent display: detail=%+v summary=%+v", detail, summary)
			}
			retried, err := s.RetryTask(task.UserID, task.ID)
			if state == "preparation" {
				if err != nil || retried.Status != model.TaskStatusQueued {
					t.Fatalf("preparation cannot be manually requeued: %+v %v", retried, err)
				}
			} else if err == nil {
				t.Fatalf("%s allowed another model submission", state)
			}
		})
	}
}
