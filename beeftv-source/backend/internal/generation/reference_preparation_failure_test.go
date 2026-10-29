package generation

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestReferencePreparationSavedCopySeparatesManualAndAutomaticRetry(t *testing.T) {
	for code, copy := range referencePreparationCopies {
		original := Failure{Category: CategoryProviderUnavailable, ProviderCode: code, Reason: copy.reason, Action: copy.action, RequestID: "request-123456", TaskID: "task-123456"}
		for _, text := range []string{original.UserMessage(), copy.reason + "。" + copy.action + "。"} {
			restored := ClassifyText(text)
			if restored.ProviderCode != code || restored.UserMessage() != text || restored.Uncertain || restored.Retryable || !restored.BlocksAutomaticRetry() || restored.BlocksManualRetry() {
				t.Fatalf("saved preparation was not restored: %+v", restored)
			}
		}
		for _, text := range []string{copy.reason, "参考图片上传失败", copy.reason + "。请重新生成。", original.UserMessage() + " extra"} {
			if _, restored := persistedReferencePreparationFailure(text); restored {
				t.Fatalf("unproved text restored preparation: %q", text)
			}
		}
	}
}

func TestUpstreamCannotAttestPreparationByEchoingSavedCopy(t *testing.T) {
	for code, copy := range referencePreparationCopies {
		message := (Failure{Category: CategoryProviderUnavailable, ProviderCode: code, Reason: copy.reason, Action: copy.action}).UserMessage()
		for _, err := range []error{errors.New(message), PayloadError{message: message}, PayloadError{raw: fmt.Sprintf(`{"error":{"code":%q,"message":%q}}`, code, message)}} {
			failure := ClassifyError(UncertainVideoSubmission(context.Background(), err))
			if !failure.Uncertain || !failure.BlocksManualRetry() {
				t.Fatalf("untyped echoed copy granted retry: %+v", failure)
			}
		}
		for _, body := range []string{message, fmt.Sprintf(`{"error":{"code":%q,"message":%q}}`, code, message)} {
			for _, status := range []int{400, 403, 503} {
				err := UncertainVideoSubmission(context.Background(), HTTPError{StatusCode: status, Body: body})
				failure := ClassifyError(err)
				if !failure.Uncertain || !failure.BlocksAutomaticRetry() || !failure.BlocksManualRetry() {
					t.Fatalf("HTTP %d echoed copy granted retry: %+v", status, failure)
				}
			}
		}
	}
}

func TestEarlierUnknownDominatesLaterPreparation(t *testing.T) {
	for _, cause := range []error{RequestPreparationError{Cause: HTTPError{StatusCode: 503, Body: `{"error":{"code":"image_reference_upload_failed"}}`}}, RequestNotSentError{Cause: context.DeadlineExceeded}, context.Canceled, HTTPError{StatusCode: 403}} {
		err := SubmissionUnknownError{Cause: cause}
		failure := ClassifyError(err)
		if !failure.Uncertain || !failure.BlocksManualRetry() || !failure.BlocksAutomaticRetry() {
			t.Fatalf("unknown was cleared by a nested unsent error: %+v", failure)
		}
		if SafeRouteRejection(err) {
			t.Fatalf("unknown was allowed to start another route: %v", err)
		}
	}
}

func TestTypedGatewayProofRetainsPreparationCopy(t *testing.T) {
	message := "参考图片上传失败，本次尚未开始生成。请稍后重试。"
	body := fmt.Sprintf(`{"error":{"code":"image_reference_upload_failed","message":%q,"metadata":{"submission_state":"not_submitted"}}}`, message)
	failure := ClassifyError(RequestPreparationError{Cause: HTTPError{StatusCode: 503, Body: body}})
	if failure.UserMessage() != message || failure.Uncertain || failure.Retryable || failure.BlocksManualRetry() || !failure.BlocksAutomaticRetry() {
		t.Fatalf("typed gateway proof lost to untrusted HTTP guard: %+v", failure)
	}
}
