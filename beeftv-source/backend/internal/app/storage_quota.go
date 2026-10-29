package app

import (
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/kernel"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
)

type AccountFileStorageUsage struct {
	UsedBytes  int64 `json:"usedBytes"`
	TotalBytes int64 `json:"totalBytes"`
}

func (s *Service) AccountFileStorageUsage(userID string) (*AccountFileStorageUsage, error) {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	usedBytes, err := s.repo.UserStoredFileBytes(userID)
	if err != nil {
		return nil, err
	}
	return &AccountFileStorageUsage{
		UsedBytes:  usedBytes,
		TotalBytes: gigabytes(policy.Resource.StoredFileGB),
	}, nil
}

func structuredBytes(usage repository.UserStorageUsage) int64 {
	return usage.AssetBytes + usage.CanvasBytes
}

func validateStructuredStorageQuotaWithPolicy(usage repository.UserStorageUsage, kind string, creating bool, deltaBytes int64, policy RuntimeResourcePolicy) error {
	created := 0
	if creating {
		created = 1
	}
	return validateStructuredCountQuotaWithPolicy(usage, kind, created, deltaBytes, policy)
}

func validateStructuredCountQuotaWithPolicy(usage repository.UserStorageUsage, kind string, createdCount int, deltaBytes int64, policy RuntimeResourcePolicy) error {
	if structuredBytes(usage)+deltaBytes > megabytes(policy.StructuredDataMB) {
		return QuotaExceeded(fmt.Sprintf("账号画布和素材数据已达到 %dMB 上限，请先删除不需要的内容", policy.StructuredDataMB))
	}
	if createdCount <= 0 {
		return nil
	}
	switch kind {
	case "asset":
		if usage.AssetCount+int64(createdCount) > policy.AssetCount {
			return QuotaExceeded(fmt.Sprintf("账号素材数量已达到 %d 个上限", policy.AssetCount))
		}
	case "canvas":
		if usage.CanvasCount+int64(createdCount) > policy.CanvasCount {
			return QuotaExceeded(fmt.Sprintf("账号画布数量已达到 %d 个上限", policy.CanvasCount))
		}
	}
	return nil
}

func validateTaskStorageQuotaWithPolicy(usage repository.UserStorageUsage, incomingBytes int64, policy RuntimeResourcePolicy) error {
	if usage.TaskCount >= policy.TaskCount {
		return QuotaExceeded(fmt.Sprintf("账号任务历史已达到 %d 条上限，请联系管理员归档", policy.TaskCount))
	}
	return validateTaskDataGrowthQuotaWithPolicy(usage, incomingBytes, policy)
}

func validateTaskDataGrowthQuotaWithPolicy(usage repository.UserStorageUsage, incomingBytes int64, policy RuntimeResourcePolicy) error {
	if usage.TaskBytes+incomingBytes > gigabytes(policy.TaskDataGB) {
		return QuotaExceeded(fmt.Sprintf("账号任务历史数据已达到 %dGB 上限，请联系管理员归档", policy.TaskDataGB))
	}
	return nil
}

func validateAPICallLogQuotaWithPolicy(usage repository.UserStorageUsage, incomingBytes int64, policy RuntimeResourcePolicy) error {
	if usage.APICallCount >= policy.APICallLogCount {
		return QuotaExceeded(fmt.Sprintf("账号上游请求日志已达到 %d 条上限，请联系管理员归档", policy.APICallLogCount))
	}
	return validateTaskDataGrowthQuotaWithPolicy(usage, incomingBytes, policy)
}

func validateStructuredReplacementQuotaWithPolicy(usage repository.UserStorageUsage, kind string, count int, bytes int64, policy RuntimeResourcePolicy) error {
	deltaBytes := bytes
	switch kind {
	case "asset":
		if int64(count) > policy.AssetCount {
			return QuotaExceeded(fmt.Sprintf("账号素材数量不能超过 %d 个", policy.AssetCount))
		}
		deltaBytes -= usage.AssetBytes
	case "canvas":
		if int64(count) > policy.CanvasCount {
			return QuotaExceeded(fmt.Sprintf("账号画布数量不能超过 %d 个", policy.CanvasCount))
		}
		deltaBytes -= usage.CanvasBytes
	}
	return validateStructuredStorageQuotaWithPolicy(usage, kind, false, deltaBytes, policy)
}

func (s *Service) createTaskWithinStorageQuota(task *model.Task, policy RuntimePolicySetting) error {
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	return createTaskWithStorageQuotaRepository(s.repo, task, policy)
}

func createTaskWithStorageQuotaRepository(repo *repository.Repository, task *model.Task, policy RuntimePolicySetting) error {
	usage, err := repo.UserStorageUsage(task.UserID)
	if err != nil {
		return taskStorageError(err)
	}
	incomingBytes := int64(len([]byte(task.Prompt)) + len([]byte(task.InputJSON)) + len([]byte(task.Error)))
	if err := validateTaskStorageQuotaWithPolicy(usage, incomingBytes, policy.Resource); err != nil {
		return err
	}
	err = repo.CreateTaskWithActiveLimit(task, policy.Task.ActiveTaskLimit)
	if err == nil || errors.Is(err, repository.ErrActiveTaskLimit) || errors.Is(err, repository.ErrLogicalModelUnavailable) {
		return err
	}
	return taskStorageError(err)
}

func taskStorageError(cause error) error {
	if full := kernel.DiskFullError(cause); full != nil {
		return full
	}
	if mapped := localtask.AdmissionValidationError(cause); mapped != nil {
		return mapped
	}
	return &AppError{Status: 500, Code: 500, Reason: "local_storage_failed", Message: "本地任务保存失败，尚未提交生成。请重启 BeefTV 后重试；若仍失败，请更新应用并联系支持", Cause: cause}
}

// 任务完成会同时扩张任务历史和画布操作数据，必须在同一临界区核算并原子写入。
func (s *Service) saveTaskCompletionWithinStorageQuota(task *model.Task, resultJSON []byte, opsJSON []byte, hasCanvasOps bool) (returnErr error) {
	defer func() {
		if full := kernel.DiskFullError(returnErr); full != nil {
			returnErr = full
		}
	}()
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()

	usage, err := s.repo.UserStorageUsage(task.UserID)
	if err != nil {
		return err
	}
	publicInputJSON, err := s.completionInputJSON(*task, resultJSON)
	if err != nil {
		return err
	}
	sourceCipher, err := s.captureCanvasWorkflowSource(*task)
	if err != nil {
		return err
	}
	taskDelta := int64(len(resultJSON) + len(publicInputJSON) + len(sourceCipher) - len(task.ResultJSON) - len(task.InputJSON) - len(task.WorkflowSourceCipher))

	results := make([]model.Result, 0, 2)
	structuredDelta := int64(0)
	if hasCanvasOps {
		results = append(results, model.Result{ID: newID(), UserID: task.UserID, TaskID: task.ID, Kind: "canvas_ops", Payload: string(opsJSON)})
	}
	for index := range results {
		taskDelta += int64(len(results[index].URL) + len(results[index].Payload))
	}
	if err := validateTaskDataGrowthQuotaWithPolicy(usage, taskDelta, policy.Resource); err != nil {
		return err
	}
	if err := validateStructuredStorageQuotaWithPolicy(usage, "canvas", false, structuredDelta, policy.Resource); err != nil {
		return err
	}

	expectedStatus := task.Status
	completed := *task
	completed.Status = model.TaskStatusSucceeded
	completed.Stage = "任务完成"
	completed.Progress = 100
	completed.ResultJSON = string(resultJSON)
	completed.InputJSON = publicInputJSON
	completed.WorkflowSourceCipher = sourceCipher
	completed.CompletedAt = ptr(time.Now())
	if err := s.repo.SaveTaskCompletion(&completed, expectedStatus, results); err != nil {
		return err
	}
	*task = completed
	return nil
}
