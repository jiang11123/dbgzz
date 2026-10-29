package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/generation"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/taskruntime"
)

const newAPIChannel2TaskSyncMaxAge = 5 * time.Minute

// taskWorkerCoordinator 是 app 侧兼容入口：保留现有方法名给测试和 Service 调用方，
// 实际领取、租约、排空和执行窗口由 internal/taskruntime 拥有。
type taskWorkerCoordinator struct {
	service *Service
	runtime *taskruntime.Runtime
}

const workerSlotLeaseDuration = time.Minute

func newTaskWorkerCoordinator(service *Service) *taskWorkerCoordinator {
	w := &taskWorkerCoordinator{service: service}
	w.runtime = newAppTaskRuntime(w)
	return w
}

func (s *Service) taskWorker() *taskWorkerCoordinator {
	if s.taskWorkerCoordinator != nil {
		return s.taskWorkerCoordinator
	}
	// 部分单元测试直接构造 Service 字面量；延迟创建保持这些测试和内部工具兼容。
	return newTaskWorkerCoordinator(s)
}

func (w *taskWorkerCoordinator) start(ctx context.Context) {
	s := w.service
	s.startTextReplayCleanup(ctx)
	s.startProviderCancellationReconciliation(ctx)
	s.startGenerationDeliveryRecovery(ctx)
	s.startCanvasWorkflowScheduler(ctx)
	// 旧内置 Agent 的后台调度已整体从产品生命周期移出：
	//   - 不再启动记忆自动压缩（它会按周期调用用户的文本模型）；
	//   - 不再按运行模式启动 advanceCloudAgents 轮次调度。
	// 两者都不会在 local/hosted 任何 profile 下重新驱动旧 Agent 的半成品流程。
	// 历史任务、运行状态、偏好与记忆数据保留在本地数据库，不做破坏性迁移。
	if w.runtime == nil {
		w.runtime = newAppTaskRuntime(w)
	}
	w.runtime.StartLoop()
}

func (w *taskWorkerCoordinator) processNextTask() error {
	if w.runtime == nil {
		w.runtime = newAppTaskRuntime(w)
	}
	return w.runtime.ProcessOne(context.Background()).Err
}

func (w *taskWorkerCoordinator) executeClaimed(session taskruntime.Session) taskruntime.Outcome {
	s := w.service
	task := session.Task()
	ctx := session.Context()
	// 产品边界：旧内置 Agent 的 cloud_agent / cloud_agent_step 任务不再执行。历史遗留的
	// 排队任务若被领走，会在这里以明确原因终止，而不是当成普通文本生成调用模型；
	// 保留任务行本身（数据不删）以便追溯。
	if retiredAgentTask(task) {
		// 任务已被终态收尾（含失败日志），这不是 worker 执行失败，因此返回 nil。
		err := s.terminalCoordinator().refuse(task, "功能已下线", retiredAgentBoundaryMessage)
		return taskruntime.Outcome{Kind: taskruntime.KindRejected, Err: err, Applied: err == nil}
	}
	terminal := s.terminalCoordinator()
	_ = s.log(task.UserID, task.ID, "info", "后端任务开始处理", "")
	// 取消请求可能在任务领取和注册 worker context 之间到达；再次读取终态
	// 可以避免这种极窄窗口仍然向上游发起调用。
	if latest, latestErr := s.repo.Task(task.ID); latestErr == nil && latest.Status == model.TaskStatusCancelled {
		err := terminal.handleAlreadyCancelled(*latest)
		return taskruntime.Outcome{Kind: taskruntime.KindCancelled, Err: err, Applied: true}
	}

	// 时间线转写由本地 whisper.cpp 执行，不经模型渠道路由，
	// 在进入通用生成流程前按类型分叉到独立执行器。
	if task.Type == model.TaskTypeTimelineTranscription {
		return w.specialTaskOutcome(session, w.processTimelineTranscription)
	}
	if task.Type == model.TaskTypeTimelineRender {
		return w.specialTaskOutcome(session, w.processTimelineRender)
	}
	if task.Type == model.TaskTypeDepthCapture {
		return w.specialTaskOutcome(session, w.processDepthCapture)
	}
	if task.Type == model.TaskTypeCanvasMediaTransform {
		return w.specialTaskOutcome(session, w.processCanvasMedia)
	}

	task.Stage = "调用生成模型"
	task.Progress = 35
	if taskUsesUpstreamReportedProgress(task.Type) {
		// 图片/视频百分比只能来自供应商状态响应。连接和提交阶段只展示文案，
		// 不能再用统一的 35% 冒充真实生成进度。
		task.Stage = "正在连接上游"
		task.Progress = 0
	}
	if err := s.repo.UpdateTaskProgressForLease(task.ID, task.LeaseOwner, task.Stage, task.Progress); err != nil {
		return taskruntime.Outcome{Kind: taskruntime.KindFailed, Err: fmt.Errorf("更新任务进度失败，任务暂未调用上游：%w", err)}
	}
	routeAttempt, err := s.beginTaskRouteAttempt(task)
	if err != nil {
		uncertain := isRouteDispatchUncertain(err)
		termErr := terminal.markPreparationFailure(task, "路由准备失败", err, uncertain, "路由准备失败，上游请求未发出")
		kind := taskruntime.KindFailed
		if uncertain {
			kind = taskruntime.KindUncertain
		}
		return taskruntime.Outcome{Kind: kind, Err: termErr, Applied: terminalWriteApplied(termErr, err)}
	}
	routeResult, stateErr := s.routeExecutor().execute(ctx, task, routeAttempt)
	if stateErr != nil {
		kind := taskruntime.KindFailed
		if isRouteDispatchUncertain(stateErr) {
			kind = taskruntime.KindUncertain
		}
		return taskruntime.Outcome{Kind: kind, Err: stateErr, ProviderAccepted: strings.TrimSpace(task.ProviderRequestID) != ""}
	}
	if session.Lost() {
		return leaseLostOutcome(session, strings.TrimSpace(task.ProviderRequestID) != "")
	}
	result, canvasOps, err := routeResult.result, routeResult.canvasOps, routeResult.err
	providerSucceeded := routeResult.providerSucceeded
	providerAccepted := providerSucceeded || strings.TrimSpace(task.ProviderRequestID) != ""
	if err == nil {
		result, err = s.persistTaskGeneratedMediaResult(*task, result)
	}
	if err == nil {
		_, err = s.finalizeCharacterTurnaroundTask(*task, result)
	}
	if err != nil {
		channelSlotFailedBeforeRequest := false
		if code, _ := ChannelSlotFailureDetails(err); code != "" {
			channelSlotFailedBeforeRequest = true
		}
		if session.Lost() {
			_ = s.log(task.UserID, task.ID, "warn", "任务租约失效，等待其他 worker 恢复", session.LostErr().Error())
			return leaseLostOutcome(session, providerAccepted)
		}
		decryptedInput, decryptErr := s.decryptTaskInputJSON(task.InputJSON)
		if s.shouldDeferImageRecovery(*task, err, providerSucceeded) {
			deferErr := s.deferImageRecovery(*task)
			return taskruntime.Outcome{Kind: taskruntime.KindSuspended, Err: deferErr, Applied: deferErr == nil, ProviderAccepted: true}
		}
		if decryptErr == nil && s.shouldDeferVideoProviderTask(*task, decryptedInput, err) {
			stage := "后台仍在生成"
			message := "前台等待结束，上游视频仍在生成，将继续回查原任务"
			var downloadErr videoDownloadError
			if errors.As(err, &downloadErr) {
				stage = "正在取回生成结果"
				message = "视频已生成，下载暂时中断，将继续取回原任务结果"
			}
			var pendingErr providerStatePendingError
			if errors.As(err, &pendingErr) {
				stage = "等待上游任务同步"
				message = "上游任务状态暂未同步，将继续回查原任务"
			}
			if task.FailureDiagnostics != nil {
				task.FailureDiagnostics.ExecutionResult = "pending"
			}
			if deferErr := s.repo.DeferRunningTaskForProviderPoll(task.ID, task.LeaseOwner, stage, 15*time.Second, task.FailureDiagnostics); deferErr != nil {
				return taskruntime.Outcome{Kind: taskruntime.KindFailed, Err: deferErr, ProviderAccepted: true}
			}
			_ = s.log(task.UserID, task.ID, "info", message, task.PollStage)
			return taskruntime.Outcome{Kind: taskruntime.KindSuspended, Applied: true, ProviderAccepted: true}
		}
		if newAPIChannel2TaskSyncExpired(*task, err, time.Now()) {
			err = errors.New("上游任务长时间未同步，已停止自动查询，请确认渠道任务状态后重试。")
		}
		var imageRecovery imageRecoveryError
		if errors.Is(err, context.DeadlineExceeded) && !errors.As(err, &imageRecovery) {
			err = errors.New(taskTimeoutMessage(task.Type))
		}
		return executionFailureOutcome(terminal, task, err, providerSucceeded, providerAccepted, channelSlotFailedBeforeRequest)
	}
	latest, err := s.repo.Task(task.ID)
	if err != nil {
		return taskruntime.Outcome{Kind: taskruntime.KindFailed, Err: err, ProviderAccepted: providerAccepted}
	}
	if latest.Status == model.TaskStatusCancelled {
		termErr := terminal.handleCancelledResult(*latest)
		return taskruntime.Outcome{Kind: taskruntime.KindCancelled, Err: termErr, Applied: true, ProviderAccepted: providerAccepted}
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return persistenceFailureOutcome(terminal, task, fmt.Errorf("序列化任务结果失败：%w", err), providerAccepted)
	}
	opsJSON, err := json.Marshal(canvasOps)
	if err != nil {
		return persistenceFailureOutcome(terminal, task, fmt.Errorf("序列化画布操作失败：%w", err), providerAccepted)
	}
	if session.Lost() {
		return leaseLostOutcome(session, true)
	}
	if err := s.saveTaskCompletionWithinStorageQuota(task, resultJSON, opsJSON, len(canvasOps) > 0); err != nil {
		if s.shouldDeferImageRecovery(*task, err, true) {
			deferErr := s.deferImageRecovery(*task)
			return taskruntime.Outcome{Kind: taskruntime.KindSuspended, Err: deferErr, Applied: deferErr == nil, ProviderAccepted: true}
		}
		return persistenceFailureOutcome(terminal, task, err, true)
	}
	termErr := terminal.handleSuccess(task)
	return taskruntime.Outcome{Kind: taskruntime.KindCompleted, Err: termErr, Applied: true, ProviderAccepted: true}
}

func (w *taskWorkerCoordinator) specialTaskOutcome(session taskruntime.Session, run func(*model.Task, context.Context) error) taskruntime.Outcome {
	err := run(session.Task(), session.Context())
	if session.Lost() {
		return leaseLostOutcome(session, false)
	}
	if err == nil {
		return taskruntime.Outcome{Kind: taskruntime.KindCompleted, Applied: true}
	}
	if errors.Is(err, context.Canceled) {
		return taskruntime.Outcome{Kind: taskruntime.KindCancelled, Err: err}
	}
	return taskruntime.Outcome{Kind: taskruntime.KindFailed, Err: err}
}

func leaseLostOutcome(session taskruntime.Session, providerAccepted bool) taskruntime.Outcome {
	err := session.LostErr()
	if err == nil {
		err = taskruntime.ErrLeaseLost
	}
	kind := taskruntime.KindLeaseLost
	if providerAccepted {
		kind = taskruntime.KindUncertain
	}
	return taskruntime.Outcome{
		Kind:             kind,
		Err:              fmt.Errorf("任务租约失效，停止保存上游结果：%w", err),
		ProviderAccepted: providerAccepted,
	}
}

func executionFailureOutcome(terminal *taskTerminalCoordinator, task *model.Task, err error, providerSucceeded, providerAccepted, channelSlotFailedBeforeRequest bool) taskruntime.Outcome {
	termErr := terminal.handleExecutionFailure(task, err, providerSucceeded, channelSlotFailedBeforeRequest)
	if errors.Is(err, context.Canceled) && termErr == nil {
		return taskruntime.Outcome{Kind: taskruntime.KindCancelled, Applied: true, ProviderAccepted: providerAccepted}
	}
	kind := taskruntime.KindFailed
	var imageRecovery imageRecoveryError
	var unknown providerSubmissionUnknownError
	if errors.As(err, &imageRecovery) || errors.As(err, &unknown) {
		kind = taskruntime.KindUncertain
	}
	return taskruntime.Outcome{Kind: kind, Err: termErr, Applied: terminalWriteApplied(termErr, err), ProviderAccepted: providerAccepted}
}

func persistenceFailureOutcome(terminal *taskTerminalCoordinator, task *model.Task, err error, providerAccepted bool) taskruntime.Outcome {
	handled, termErr := terminal.handleResultPersistenceFailure(task, err)
	if handled {
		return taskruntime.Outcome{Kind: taskruntime.KindCancelled, Err: termErr, Applied: termErr == nil, ProviderAccepted: providerAccepted}
	}
	return taskruntime.Outcome{Kind: taskruntime.KindFailed, Err: termErr, Applied: terminalWriteApplied(termErr, err), ProviderAccepted: providerAccepted}
}

func terminalWriteApplied(termErr, cause error) bool {
	if termErr == nil {
		return true
	}
	var joined interface{ Unwrap() []error }
	if errors.As(termErr, &joined) {
		return false
	}
	return cause != nil && errors.Is(termErr, cause)
}

func taskUsesUpstreamReportedProgress(taskType string) bool {
	return taskType == "canvas_image" || taskType == "canvas_video" || strings.HasPrefix(taskType, "video_")
}

func taskFailureMessage(err error) string {
	if err == nil {
		return persistableTaskFailureMessage(err)
	}
	return truncateRunes(persistableTaskFailureMessage(err), 2_000)
}

func taskExecutionTimeoutWithPolicy(taskType string, policy RuntimeTaskPolicy) time.Duration {
	switch {
	case strings.HasPrefix(taskType, "canvas_video") || strings.HasPrefix(taskType, "video_"):
		return max(time.Duration(policy.VideoTimeoutMinutes)*time.Minute, 5*time.Minute)
	case strings.HasPrefix(taskType, "canvas_image"):
		return time.Duration(policy.ImageTimeoutMinutes) * time.Minute
	case strings.HasPrefix(taskType, "canvas_audio"):
		return time.Duration(policy.AudioTimeoutMinutes) * time.Minute
	case strings.HasPrefix(taskType, "canvas_text"):
		return time.Duration(policy.TextTimeoutMinutes) * time.Minute
	case taskType == model.TaskTypeTimelineTranscription:
		// 本地转写受媒体时长影响，给出独立宽松超时。
		return 20 * time.Minute
	case taskType == model.TaskTypeTimelineRender:
		// 渲染是整条时间线的重编码，耗时随长度线性增长。
		return 60 * time.Minute
	case taskType == model.TaskTypeDepthCapture:
		// 首次执行包含可选 Runtime 和模型下载。
		return 2 * time.Hour
	default:
		return time.Duration(policy.DefaultTimeoutMinutes) * time.Minute
	}
}

func (s *Service) shouldDeferVideoProviderTask(task model.Task, decryptedInput string, err error) bool {
	providerRequestID := strings.TrimSpace(task.ProviderRequestID)
	if providerRequestID == "" || (!strings.HasPrefix(task.Type, "canvas_video") && !strings.HasPrefix(task.Type, "video_") && generation.UpscaleMediaType(task.Model) == "") {
		return false
	}
	deferSignal := errors.Is(err, context.DeadlineExceeded)
	var dns *outbound.DNSResolutionError
	if errors.As(err, &dns) {
		deferSignal, _ = retryableVideoPollError(context.Background(), err)
	}
	var downloadErr videoDownloadError
	if errors.As(err, &downloadErr) {
		deferSignal, _ = retryableVideoPollError(context.Background(), downloadErr.Cause)
	}
	// Bound automatic recovery; keep the original ID for manual retrieval later.
	if task.StartedAt != nil && time.Since(*task.StartedAt) >= 24*time.Hour {
		return false
	}
	var pendingErr providerStatePendingError
	if errors.As(err, &pendingErr) {
		deferSignal = strings.TrimSpace(pendingErr.TaskID) == providerRequestID && !newAPIChannel2TaskSyncExpired(task, err, time.Now())
	}
	if !deferSignal {
		return false
	}
	var input canvasGenerationInput
	if json.Unmarshal([]byte(decryptedInput), &input) != nil {
		return false
	}
	// Selecting the known query-only contract does not need another DNS lookup.
	// The resumed GET still runs the normal URL/IP and credential checks.
	if input.Config.ChannelID == "" && isBeefAPIVideoConfig(context.Background(), input.Config) {
		return true
	}
	resolved, resolveErr := s.resolveProviderConfig(input.Config)
	return resolveErr == nil && (resolved.InterfaceType == string(model.ChannelInterfaceNewAPIChannel2) || isBeefAPIVideoConfig(context.Background(), resolved))
}

func newAPIChannel2TaskSyncExpired(task model.Task, err error, now time.Time) bool {
	var pendingErr providerStatePendingError
	if !errors.As(err, &pendingErr) || strings.TrimSpace(pendingErr.TaskID) == "" || strings.TrimSpace(pendingErr.TaskID) != strings.TrimSpace(task.ProviderRequestID) {
		return false
	}
	if task.StartedAt == nil {
		return true
	}
	return !now.Before(task.StartedAt.Add(newAPIChannel2TaskSyncMaxAge))
}

func taskTimeoutMessage(taskType string) string {
	if strings.HasPrefix(taskType, "canvas_video") || strings.HasPrefix(taskType, "video_") {
		return "视频生成等待超时，请稍后到任务中心查看或重试。"
	}
	if strings.HasPrefix(taskType, "canvas_image") {
		return "图片生成等待超时，请稍后重试。"
	}
	return "任务执行超时，请稍后重试。"
}
