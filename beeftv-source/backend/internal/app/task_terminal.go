package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const taskStageRequestNotSent = "请求尚未提交"

// taskTerminalCoordinator 收敛任务进入终态后的业务策略。
//
// 任务执行本身仍由 Service 编排，但失败、取消和成功收尾必须保持一致，
// 不能散落在 provider/worker 分支中。
type taskTerminalCoordinator struct {
	repo              taskTerminalRepository
	replay            taskReplayLifecycle
	logger            taskLifecycleLogger
	outputs           taskOutputLifecycle
	userFacingMessage func(error) string
	logFailedAttempt  func(model.Task, error)
}

type taskTerminalRepository interface {
	Task(id string) (*model.Task, error)
	UpdateTaskTerminalState(id string, owner string, expected model.TaskStatus, status model.TaskStatus, stage string, errorText string, completedAt time.Time, diagnostics ...*model.TaskFailureDiagnostics) (bool, error)
}

type taskReplayLifecycle interface {
	finalizeTaskTextReplay(taskID string, status model.TaskStatus) error
}

type taskLifecycleLogger interface {
	log(userID string, taskID string, level string, message string, payload string) error
}

type taskOutputLifecycle interface {
	DeliverSucceededTask(task model.Task) error
	RegisterTaskOutputFromTask(task model.Task) error
}

type taskTerminalServiceAdapter struct {
	finalizeReplay func(string, model.TaskStatus) error
	writeLog       func(string, string, string, string, string) error
	deliver        func(model.Task) error
	registerOutput func(model.Task) error
}

func (a taskTerminalServiceAdapter) finalizeTaskTextReplay(taskID string, status model.TaskStatus) error {
	return a.finalizeReplay(taskID, status)
}

func (a taskTerminalServiceAdapter) log(userID string, taskID string, level string, message string, payload string) error {
	return a.writeLog(userID, taskID, level, message, payload)
}

func (a taskTerminalServiceAdapter) DeliverSucceededTask(task model.Task) error {
	if a.deliver == nil {
		return nil
	}
	return a.deliver(task)
}

func (a taskTerminalServiceAdapter) RegisterTaskOutputFromTask(task model.Task) error {
	return a.registerOutput(task)
}

func newTaskTerminalCoordinator(s *Service) *taskTerminalCoordinator {
	adapter := taskTerminalServiceAdapter{
		finalizeReplay: s.finalizeTaskTextReplay,
		writeLog:       s.log,
		deliver:        s.DeliverSucceededTask,
		registerOutput: s.RegisterTaskOutputFromTask,
	}
	return &taskTerminalCoordinator{
		repo:              s.repo,
		replay:            adapter,
		logger:            adapter,
		outputs:           adapter,
		userFacingMessage: s.UserFacingErrorMessage,
		logFailedAttempt:  s.ensureFailedProviderAttemptLogged,
	}
}

func (s *Service) terminalCoordinator() *taskTerminalCoordinator {
	if s.taskTerminalCoordinator != nil {
		return s.taskTerminalCoordinator
	}
	// 部分单元测试直接构造 Service 字面量；延迟创建保持这些测试和内部工具兼容。
	return newTaskTerminalCoordinator(s)
}

func (c *taskTerminalCoordinator) markPreparationFailure(task *model.Task, stage string, err error, _ bool, _ string) error {
	captureTaskFailureDiagnostics(task, err, "unknown")
	c.ensureFailedAttemptLogged(task, err)
	task.Status = model.TaskStatusFailed
	task.Stage = stage
	task.Error = c.userFacingMessage(err)
	if terminalErr := c.markTerminalState(task); terminalErr != nil {
		return errors.Join(err, terminalErr)
	}
	return err
}

// refuse 把一条按产品边界不再支持的任务直接收尾为失败，并记录失败日志。
// 与 markPreparationFailure 的差别：用户可见原因原样落库，不经过失败分类改写——
// “按产品边界拒绝执行”本身就是正确的终态结果，不是 worker 执行失败。
func (c *taskTerminalCoordinator) refuse(task *model.Task, stage string, message string) error {
	c.ensureFailedAttemptLogged(task, errors.New(message))
	task.Status = model.TaskStatusFailed
	task.Stage = stage
	task.Error = message
	return c.markTerminalState(task)
}

// handleExecutionFailure 返回 nil 仅表示取消已被正常收尾；普通失败仍返回原始错误，
// 让 worker 保留重试/监控所需的失败语义。
func (c *taskTerminalCoordinator) handleExecutionFailure(task *model.Task, err error, providerSucceeded bool, channelSlotFailedBeforeRequest bool) error {
	if errors.Is(err, context.Canceled) {
		// 用户取消会先把数据库任务置为 cancelled，再停止 worker context。
		// 此时不再重复退款/核对，只补齐 worker 侧的回放和日志收尾。
		if latest, latestErr := c.repo.Task(task.ID); latestErr == nil && latest.Status == model.TaskStatusCancelled {
			return c.handleAlreadyCancelled(*latest)
		}
		task.Status = model.TaskStatusCancelled
		task.Stage = "任务已取消"
		task.Error = "任务已取消"
		if terminalErr := c.markTerminalState(task); terminalErr != nil {
			return terminalErr
		}
		c.finalizeReplay(task, model.TaskStatusCancelled, "文本回放草稿归并失败")
		_ = c.logger.log(task.UserID, task.ID, "warn", "任务已取消", "")
		return nil
	}

	source := "unknown"
	if providerSucceeded {
		source = "local_result"
	}
	captureTaskFailureDiagnostics(task, err, source)
	task.Status = model.TaskStatusFailed
	c.ensureFailedAttemptLogged(task, err)
	task.Stage = "任务失败"
	var imageRecovery imageRecoveryError
	var unknown providerSubmissionUnknownError
	if errors.As(err, &imageRecovery) || errors.As(err, &unknown) {
		task.Stage = "submission_unknown"
	} else {
		var preparation generation.ProtocolPreparationError
		if task.ProviderRequestID == "" && errors.As(err, &preparation) {
			task.Stage = taskStageRequestNotSent
		}
	}
	task.Error = c.userFacingMessage(err)
	if terminalErr := c.markTerminalState(task); terminalErr != nil {
		return errors.Join(err, terminalErr)
	}
	c.finalizeReplay(task, model.TaskStatusFailed, "文本回放草稿归并失败")
	_ = c.logger.log(task.UserID, task.ID, "error", "任务处理失败", task.Error)
	return err
}

func (c *taskTerminalCoordinator) handleAlreadyCancelled(task model.Task) error {
	c.finalizeReplay(&task, model.TaskStatusCancelled, "文本回放草稿归并失败")
	_ = c.logger.log(task.UserID, task.ID, "warn", "任务已取消，worker 已停止执行", "")
	return nil
}

func (c *taskTerminalCoordinator) handleCancelledResult(task model.Task) error {
	c.finalizeReplay(&task, model.TaskStatusCancelled, "文本回放草稿归并失败")
	_ = c.logger.log(task.UserID, task.ID, "warn", "任务已取消，丢弃生成结果", "")
	return nil
}

// handleResultPersistenceFailure 处理“上游成功但本地结果保存失败”的收尾。
// 返回 handled=true 表示并发取消已被识别并正常收尾，调用方不应再返回保存错误。
func (c *taskTerminalCoordinator) handleResultPersistenceFailure(task *model.Task, saveErr error) (handled bool, err error) {
	if errors.Is(saveErr, repository.ErrTaskStateConflict) {
		latest, latestErr := c.repo.Task(task.ID)
		if latestErr == nil && latest.Status == model.TaskStatusCancelled {
			if cancelErr := c.handleCancelledResult(*latest); cancelErr != nil {
				return true, cancelErr
			}
			return true, nil
		}
	}

	task.Status = model.TaskStatusFailed
	captureTaskFailureDiagnostics(task, saveErr, "local_result")
	task.Stage = "任务结果保存失败"
	task.Error = c.userFacingMessage(saveErr)
	if terminalErr := c.markTerminalState(task); terminalErr != nil {
		return false, errors.Join(saveErr, terminalErr)
	}
	c.finalizeReplay(task, model.TaskStatusFailed, "文本回放草稿归并失败")
	_ = c.logger.log(task.UserID, task.ID, "error", "任务结果保存失败", task.Error)
	return false, saveErr
}

func (c *taskTerminalCoordinator) ensureFailedAttemptLogged(task *model.Task, err error) {
	if c.logFailedAttempt == nil || task == nil || err == nil {
		return
	}
	c.logFailedAttempt(*task, err)
}

func (c *taskTerminalCoordinator) handleSuccess(task *model.Task) error {
	c.finalizeReplay(task, model.TaskStatusSucceeded, "文本回放窗口更新失败")
	var completionErr error
	completedTask, fetchErr := c.repo.Task(task.ID)
	if fetchErr != nil {
		completionErr = fmt.Errorf("任务成功后读取任务产物失败：%w", fetchErr)
		_ = c.logger.log(task.UserID, task.ID, "error", "任务成功但读取任务产物失败", fetchErr.Error())
	} else {
		if deliverErr := c.outputs.DeliverSucceededTask(*completedTask); deliverErr != nil {
			_ = c.logger.log(task.UserID, task.ID, "error", "任务成功但结果交付失败", deliverErr.Error())
			completionErr = fmt.Errorf("任务成功后的结果交付失败：%w", deliverErr)
		}
		if registerErr := c.outputs.RegisterTaskOutputFromTask(*completedTask); registerErr != nil {
			// 任务成功与产物登记分开记账；登记失败保持步骤异常，允许项目页幂等补登记。
			_ = c.logger.log(task.UserID, task.ID, "error", "任务成功但项目产物登记失败", registerErr.Error())
			completionErr = errors.Join(completionErr, fmt.Errorf("任务成功后的项目产物登记失败：%w", registerErr))
		}
		if deliverErr := c.outputs.DeliverSucceededTask(*completedTask); deliverErr != nil {
			_ = c.logger.log(task.UserID, task.ID, "error", "任务成功但结果交付失败", deliverErr.Error())
			completionErr = errors.Join(completionErr, fmt.Errorf("任务成功后的结果交付失败：%w", deliverErr))
		}
	}
	_ = c.logger.log(task.UserID, task.ID, "info", "任务完成，结果已持久化", "")
	return completionErr
}

func (c *taskTerminalCoordinator) markTerminalState(task *model.Task) error {
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	updated, err := c.repo.UpdateTaskTerminalState(task.ID, task.LeaseOwner, model.TaskStatusRunning, task.Status, task.Stage, task.Error, completedAt, task.FailureDiagnostics)
	if err != nil {
		return fmt.Errorf("写入任务终态失败：%w", err)
	}
	if !updated {
		return repository.ErrTaskStateConflict
	}
	return nil
}

func (c *taskTerminalCoordinator) finalizeReplay(task *model.Task, status model.TaskStatus, message string) {
	if err := c.replay.finalizeTaskTextReplay(task.ID, status); err != nil {
		_ = c.logger.log(task.UserID, task.ID, "error", message, err.Error())
	}
}
