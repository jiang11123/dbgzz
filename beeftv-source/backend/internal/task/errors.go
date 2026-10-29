package task

import (
	"errors"
	"fmt"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const (
	RetiredAgentBoundaryMessage                        = "Agent 能力已下线，请在画布中手动创建节点并生成"
	RetiredCloudAgentPrefix                            = "cloud_agent"
	RetiredMemoryCompactOp                             = "agent_memory_compact"
	LocalStorageFailedMessage                          = "本地任务保存失败，尚未提交生成。请重启 BeefTV 后重试；若仍失败，请更新应用并联系支持"
	DrainCreateMessage                                 = "服务正在维护，暂不接受新的生成任务"
	DrainRetryMessage                                  = "服务正在维护，暂不接受任务重试"
	ClientOperationConflictMessage                     = "同一生成确认已用于不同内容，没有新建任务"
	CancellationPendingRetryMessage                    = "上一次取消请求仍在确认中，请稍后重试"
	ContentModerationRetryMessage                      = "内容未通过安全审核，请修改提示词或参考图后重新生成；原任务不能直接重试"
	SubmissionUncertainRetryMessage                    = "提交结果尚未确认，请先查询原任务，不要立即重新提交"
	DownloadFailureRetryMessage                        = "生成结果下载失败，请先重新加载或查询原任务，不要立即重新提交"
	CreationRetryConflictMessage                       = "智能创作重做需要新的报价批准，请回到创作会话继续"
	LogicalModelUnavailableMessage                     = "所选模型已停用、归档或配置已更新，请重新选择"
	TaskScopeArchivedMessage                           = "项目已归档，无法创建生成任务"
	TaskScopeUnavailableMessage                        = "当前画布或项目不可用，无法创建生成任务"
	ResourceNotReadyMessage                            = "参考素材还没准备好，请确认文件已上传完成后再试"
	TaskInputInvalidMessage                            = "任务输入无法解析，请重新提交"
	RetryNotRetryableMessage                           = "任务已被其他请求重新入队，请勿重复重试"
	RetryOnlyFailedOrCancelled                         = "only failed or cancelled tasks can be retried"
	PromptRequiredMessage                              = "请填写提示词"
	InlineMediaRejectedMessage                         = "任务输入不能包含内嵌媒体，请先上传到资源存储"
	VideoModeRequiredMessage                           = "视频任务必须使用 video 模式"
	VideoConfigRequiredMessage                         = "视频任务缺少可执行的模型配置"
	CancelChangedMessage                               = "任务状态已变化，请刷新后重试"
	LocalStorageFailedReason        kernel.ErrorReason = "local_storage_failed"
)

func unavailable() error {
	return kernel.NewAppError(kernel.CodeInternal, "任务服务不可用")
}

func localStorageFailed(cause error) error {
	if full := kernel.DiskFullError(cause); full != nil {
		return full
	}
	return &kernel.AppError{
		Status:  kernel.CodeInternal,
		Code:    kernel.CodeInternal,
		Reason:  LocalStorageFailedReason,
		Message: LocalStorageFailedMessage,
		Cause:   cause,
	}
}

func drainError(message string) error {
	return &kernel.AppError{Status: kernel.CodeUnavailable, Code: kernel.CodeUnavailable, Message: message, Retryable: true}
}

func activeLimitError(limit int) error {
	return kernel.BadAuthRequest(fmt.Sprintf("同时排队或运行的任务最多 %d 个，请等待已有任务完成", limit))
}

func mapPersistError(err error, req CreateRequest, present Presenter, limit int) (*model.Task, error) {
	if err == nil {
		return nil, nil
	}
	var replay *repository.ClientOperationReplay
	if errors.As(err, &replay) {
		return admitExisting(replay.Task, req, present)
	}
	if errors.Is(err, repository.ErrActiveTaskLimit) {
		return nil, activeLimitError(limit)
	}
	if errors.Is(err, repository.ErrLogicalModelUnavailable) {
		return nil, kernel.BadAuthRequest(LogicalModelUnavailableMessage)
	}
	if mapped := mapTaskScopeError(err); mapped != nil {
		return nil, mapped
	}
	if mapped := mapTaskResourceError(err); mapped != nil {
		return nil, mapped
	}
	var appErr *kernel.AppError
	if errors.As(err, &appErr) && appErr != nil {
		return nil, err
	}
	return nil, localStorageFailed(err)
}

func mapTaskScopeError(err error) error {
	if errors.Is(err, repository.ErrTaskScopeArchived) {
		return kernel.BadAuthRequest(TaskScopeArchivedMessage)
	}
	if errors.Is(err, repository.ErrTaskScopeNotActive) {
		return kernel.BadAuthRequest(TaskScopeUnavailableMessage)
	}
	return nil
}

func mapTaskResourceError(err error) error {
	if errors.Is(err, repository.ErrResourceNotReadyForAdmission) {
		return kernel.BadAuthRequest(ResourceNotReadyMessage)
	}
	if errors.Is(err, repository.ErrTaskInputInvalid) {
		return kernel.BadAuthRequest(TaskInputInvalidMessage)
	}
	return nil
}

// AdmissionValidationError maps shared repository preconditions for specialized
// task creators (render, transcription, depth) using the same admission rules.
// A nil result means the error is not a known validation failure.
func AdmissionValidationError(err error) error {
	if mapped := mapTaskScopeError(err); mapped != nil {
		return mapped
	}
	return mapTaskResourceError(err)
}
