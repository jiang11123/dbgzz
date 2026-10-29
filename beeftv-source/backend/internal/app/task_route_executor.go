package app

import (
	"context"
	"errors"
	"infinite-canvas/backend/internal/generation"
	"time"

	"infinite-canvas/backend/internal/model"
)

// taskRouteExecutor 负责一次任务执行中的路由提交与失败切换策略。
// Provider 具体协议仍由 processTask 和各 provider 函数负责；这里仅管理“何时结束当前路由、何时允许换路由”。
type taskRouteExecutor struct {
	port taskRouteExecutionPort
}

type taskRouteExecutionPort interface {
	markRouteAttemptDispatching(attempt *model.RouteAttempt) error
	processTask(ctx context.Context, task model.Task) (map[string]interface{}, []map[string]interface{}, error)
	refreshTaskProviderState(task *model.Task) error
	finishTaskRouteAttempt(attempt *model.RouteAttempt, task *model.Task, taskErr error)
	nextRouteAttemptAfterFailure(task *model.Task, attempt *model.RouteAttempt, taskErr error) (*model.RouteAttempt, error)
	log(userID string, taskID string, level string, message string, payload string) error
}

type taskRouteExecutionResult struct {
	result            map[string]interface{}
	canvasOps         []map[string]interface{}
	err               error
	providerSucceeded bool
}

type taskRouteServiceAdapter struct {
	markDispatching  func(*model.RouteAttempt) error
	process          func(context.Context, model.Task) (map[string]interface{}, []map[string]interface{}, error)
	refreshState     func(*model.Task) error
	finishAttempt    func(*model.RouteAttempt, *model.Task, error)
	nextAfterFailure func(*model.Task, *model.RouteAttempt, error) (*model.RouteAttempt, error)
	writeLog         func(string, string, string, string, string) error
}

func (a taskRouteServiceAdapter) markRouteAttemptDispatching(attempt *model.RouteAttempt) error {
	return a.markDispatching(attempt)
}

func (a taskRouteServiceAdapter) processTask(ctx context.Context, task model.Task) (map[string]interface{}, []map[string]interface{}, error) {
	return a.process(ctx, task)
}

func (a taskRouteServiceAdapter) refreshTaskProviderState(task *model.Task) error {
	return a.refreshState(task)
}

func (a taskRouteServiceAdapter) finishTaskRouteAttempt(attempt *model.RouteAttempt, task *model.Task, taskErr error) {
	a.finishAttempt(attempt, task, taskErr)
}

func (a taskRouteServiceAdapter) nextRouteAttemptAfterFailure(task *model.Task, attempt *model.RouteAttempt, taskErr error) (*model.RouteAttempt, error) {
	return a.nextAfterFailure(task, attempt, taskErr)
}

func (a taskRouteServiceAdapter) log(userID string, taskID string, level string, message string, payload string) error {
	return a.writeLog(userID, taskID, level, message, payload)
}

func newTaskRouteExecutor(s *Service) *taskRouteExecutor {
	return &taskRouteExecutor{port: taskRouteServiceAdapter{
		markDispatching: s.markRouteAttemptDispatching, process: s.processTask,
		refreshState: s.refreshTaskProviderState, finishAttempt: s.finishTaskRouteAttempt,
		nextAfterFailure: s.nextRouteAttemptAfterFailure, writeLog: s.log,
	}}
}

func (s *Service) routeExecutor() *taskRouteExecutor {
	if s.taskRouteExecutor != nil {
		return s.taskRouteExecutor
	}
	// 部分单元测试直接构造 Service 字面量；延迟创建保持内部测试和工具兼容。
	return newTaskRouteExecutor(s)
}

func (e *taskRouteExecutor) execute(ctx context.Context, task *model.Task, attempt *model.RouteAttempt) (taskRouteExecutionResult, error) {
	var execution taskRouteExecutionResult
	ctx, recorder := withTaskRequestEvidence(ctx, task.FailureDiagnostics)
	defer func() { task.FailureDiagnostics = recorder.snapshot(execution.providerSucceeded) }()
	for {
		if dispatchErr := e.port.markRouteAttemptDispatching(attempt); dispatchErr != nil {
			execution.err = dispatchErr
			break
		}
		execution.result, execution.canvasOps, execution.err = e.port.processTask(withProviderSubmissionKey(ctx, attempt), *task)
		if stateErr := e.port.refreshTaskProviderState(task); stateErr != nil {
			return taskRouteExecutionResult{}, stateErr
		}
		e.port.finishTaskRouteAttempt(attempt, task, execution.err)
		if execution.err == nil {
			break
		}
		if task.Type == "canvas_image" && generation.UpscaleMediaType(task.Model) == "" && attempt != nil && attempt.DispatchState == "submission_unknown" && !isImageRecoveryError(execution.err) && !definiteVODImageParameterFailure(execution.err) {
			execution.err = imageRecoveryError{execution.err}
		}
		var upstream providerHTTPError
		if task.Type == "canvas_image" && attempt != nil && attempt.AttemptNumber < 3 && definiteImageThrottle(execution.err) && errors.As(execution.err, &upstream) {
			delay := time.Duration(1<<attempt.AttemptNumber) * time.Second
			if upstream.RetryAfter > delay {
				delay = upstream.RetryAfter
			}
			if waitErr := sleepContext(ctx, delay); waitErr != nil {
				break
			}
		}
		nextAttempt, routeErr := e.port.nextRouteAttemptAfterFailure(task, attempt, execution.err)
		if routeErr != nil {
			_ = e.port.log(task.UserID, task.ID, "warn", "备用路由不可用，保留原始失败", routeErr.Error())
			break
		}
		if nextAttempt == nil {
			break
		}
		// Route selection updates the persisted task in the service port. Keep the
		// in-memory task aligned as well because the next provider execution reads
		// its route from this object before it reaches the repository again.
		task.RouteID = nextAttempt.RouteID
		attempt = nextAttempt
		if task.Type == "canvas_image" {
			_ = e.port.log(task.UserID, task.ID, "warn", "上游限流，正在重试原图片请求", nextAttempt.ID)
		} else {
			_ = e.port.log(task.UserID, task.ID, "warn", "上游未创建任务，切换备用能力路由", nextAttempt.RouteID)
		}
	}
	execution.providerSucceeded = execution.err == nil
	return execution, nil
}
