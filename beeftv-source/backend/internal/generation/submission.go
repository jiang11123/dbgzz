package generation

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"infinite-canvas/backend/internal/platform"
)

type SubmissionUnknownError struct{ Cause error }

// SubmissionRejectedError proves a structured gateway rejection without a job.
type SubmissionRejectedError struct{ Cause error }

func (e SubmissionRejectedError) Error() string { return e.Cause.Error() }
func (e SubmissionRejectedError) Unwrap() error { return e.Cause }

// RequestNotSentError is created only from transport evidence: no HTTP
// connection was acquired during this request, including any redirects.
type RequestNotSentError struct{ Cause error }

func (e RequestNotSentError) Error() string { return e.Cause.Error() }
func (e RequestNotSentError) Unwrap() error { return e.Cause }

// RequestPreparationError proves that the create request was not dispatched.
// Reference downloads may fail after their own HTTP calls, before a paid POST.
type RequestPreparationError struct{ Cause error }

func (e RequestPreparationError) Error() string {
	return fmt.Sprintf("本次请求准备失败：%v", e.Cause)
}
func (e RequestPreparationError) Unwrap() error { return e.Cause }

// ProtocolPreparationError is emitted only by local interface validation before
// a new create request; provider messages cannot attest this failure phase.
type ProtocolPreparationError struct{ Cause error }

func (e ProtocolPreparationError) Error() string { return e.Cause.Error() }
func (e ProtocolPreparationError) Unwrap() error { return RequestPreparationError{Cause: e.Cause} }

// ReferenceStoragePreparationError is local object-storage work that failed
// before model dispatch, even if that work acquired its own HTTP connection.
type ReferenceStoragePreparationError struct{ Cause error }

func (e ReferenceStoragePreparationError) Error() string {
	return fmt.Sprintf("参考素材对象存储准备失败：%v", e.Cause)
}
func (e ReferenceStoragePreparationError) Unwrap() error { return e.Cause }

func (e SubmissionUnknownError) Error() string {
	return fmt.Sprintf("提交结果尚未确认：%v", e.Cause)
}

func (e SubmissionUnknownError) Unwrap() error { return e.Cause }

func SafeRouteRejection(err error) bool {
	if err == nil {
		return false
	}
	var unknown SubmissionUnknownError
	if errors.As(err, &unknown) {
		return false
	}
	var rejected SubmissionRejectedError
	if errors.As(err, &rejected) {
		return true
	}
	var preparation RequestPreparationError
	if errors.As(err, &preparation) {
		return true
	}
	if code, _ := platform.ChannelSlotFailureDetails(err); code != "" {
		return true
	}
	var upstream HTTPError
	if errors.As(err, &upstream) {
		// A structured missing-model response rejects routing before a task is
		// created, even when the gateway reports it as HTTP 503. Generic 5xx
		// responses and transport failures still cannot prove non-submission.
		fields := extractProviderFields(upstream.Body)
		if upstream.StatusCode >= 400 && fields.Code == "model_not_found" && fields.TaskID == "" {
			return true
		}
		switch upstream.StatusCode {
		case http.StatusUnauthorized, http.StatusPaymentRequired, http.StatusForbidden, http.StatusNotFound, http.StatusTooManyRequests:
			return true
		}
	}
	return false
}

func UncertainVideoSubmission(ctx context.Context, err error) error {
	var notSent RequestNotSentError
	var unknown SubmissionUnknownError
	if errors.As(err, &notSent) || errors.As(err, &unknown) {
		return err
	}
	var preparation RequestPreparationError
	if errors.As(err, &preparation) {
		return err
	}
	if err == nil || errors.Is(err, context.Canceled) || SafeRouteRejection(err) {
		return err
	}
	var circuit CircuitOpenError
	if errors.As(err, &circuit) {
		return err
	}
	if retry, _ := RetryableVideoPollError(context.Background(), err); retry {
		return SubmissionUnknownError{Cause: err}
	}
	return err
}
