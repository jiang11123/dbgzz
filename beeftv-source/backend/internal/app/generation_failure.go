package app

import (
	"errors"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
)

func classifyProviderHTTP(err providerHTTPError) generation.Failure {
	return generation.ClassifyHTTP(err.StatusCode, err.Status, err.Body)
}

func classifyTaskFailure(err error) generation.Failure {
	if err == nil {
		return generation.ClassifyError(nil)
	}
	failure := applyAppFailureWrappers(err, generation.ClassifyError(err))
	if failure.Category == generation.CategoryInvalidParams && !failure.Uncertain && definiteMidjourneyCountRejection(err) {
		failure.Reason = "Midjourney 需要一次请求生成 4 张图片"
		failure.Action = "请重新选择 Midjourney 模型，使用固定四张设置后重试"
	}
	return failure
}

func applyAppFailureWrappers(err error, failure generation.Failure) generation.Failure {
	var imageRecovery imageRecoveryError
	if errors.As(err, &imageRecovery) {
		failure.Category = generation.CategorySubmissionUncertain
		failure.Uncertain = true
		failure.Reason = "图片结果尚未确认，自动恢复已停止"
		failure.Action = "请保留任务记录并联系支持查询结果，不要重复提交"
		var preparation imagePreparationError
		if errors.As(err, &preparation) {
			failure.Reason = "图片提交记录无法确认，自动恢复已停止"
		}
		return failure
	}
	var preparation imagePreparationError
	if errors.As(err, &preparation) {
		failure = generation.ClassifyError(preparation.cause)
		failure.Uncertain, failure.Retryable = false, false
		failure.Reason = preparation.Error()
		failure.Action = "请保留排查信息并联系支持检查本地任务记录"
		return failure
	}
	var unknown providerSubmissionUnknownError
	if errors.As(err, &unknown) {
		failure.Category = generation.CategorySubmissionUncertain
		failure.Uncertain, failure.Retryable = true, false
		failure.Reason, failure.Action = "", ""
		return failure
	}
	var download videoDownloadError
	if errors.As(err, &download) {
		failure = generation.WithDownloadFailure(failure, download.TaskID)
	}
	var pending providerStatePendingError
	if errors.As(err, &pending) {
		failure.Category = generation.CategorySubmissionUncertain
		failure.Uncertain = true
		failure.TaskID = firstNonEmpty(failure.TaskID, pending.TaskID)
		failure.Reason = ""
		failure.Action = ""
	}
	var circuit providerCircuitOpenError
	if errors.As(err, &circuit) {
		return generation.CircuitOpenFailure()
	}
	if code, _ := ChannelSlotFailureDetails(err); code != "" {
		failure = generation.WithConcurrencyFailure(failure)
	}
	var appErr *kernel.AppError
	if errors.As(err, &appErr) && appErr != nil {
		classified := generation.ClassifyAppError(appErr.Status, appErr.Code, string(appErr.Reason), appErr.Message)
		if failure.Category == generation.CategoryUnknown || classified.Category != generation.CategoryUnknown {
			failure = classified
		}
	}
	return failure
}

func persistableTaskFailureMessage(err error) string {
	return classifyTaskFailure(err).UserMessage()
}

func taskFailureErrorCode(err error) string {
	return classifyTaskFailure(err).ErrorCode()
}

func persistedFailureErrorCode(message string, stage string) string {
	if stage == taskStageRequestNotSent {
		return string(generation.CategoryRequestNotSent)
	}
	failure := generation.ClassifyText(message)
	if stage == "submission_unknown" {
		return string(generation.CategorySubmissionUncertain)
	}
	return failure.ErrorCode()
}

func persistedFailureBlocksRetry(message string, stage string) bool {
	if stage == taskStageRequestNotSent {
		return false
	}
	if stage == "submission_unknown" {
		return true
	}
	return generation.ClassifyText(message).BlocksManualRetry()
}

func (s *Service) UserFacingProviderHTTPError(status int, statusText string, body string) string {
	message := generation.ClassifyHTTP(status, statusText, body).UserMessage()
	if s == nil {
		return message
	}
	return s.InterceptResponseText(message)
}
