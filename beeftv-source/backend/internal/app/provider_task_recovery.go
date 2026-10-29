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
	"infinite-canvas/backend/internal/provider/workflow"
	"infinite-canvas/backend/internal/repository"
)

const providerTaskRecoveryLeaseDuration = 10 * time.Minute

type ProviderTaskQueryResult struct {
	Task           *model.Task `json:"task"`
	ProviderStatus string      `json:"providerStatus"`
	Recovered      bool        `json:"recovered"`
}

func (s *Service) QueryFailedVideoTask(ctx context.Context, userID string, taskID string) (*ProviderTaskQueryResult, error) {
	task, err := s.repo.TaskForUser(strings.TrimSpace(userID), strings.TrimSpace(taskID))
	if err != nil {
		return nil, err
	}
	return s.queryFailedVideoTask(ctx, task, strings.TrimSpace(userID))
}

func (s *Service) AdminQueryFailedVideoTask(ctx context.Context, actor *model.User, logID string) (*ProviderTaskQueryResult, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	log, err := s.repo.APICallLog(strings.TrimSpace(logID))
	if err != nil {
		return nil, err
	}
	if log.Capability != "video" || strings.TrimSpace(log.TaskID) == "" {
		return nil, BadAuthRequest("该请求没有可查询的视频任务")
	}
	task, err := s.repo.Task(log.TaskID)
	if err != nil {
		return nil, err
	}
	if task.UserID != log.UserID {
		return nil, BadAuthRequest("请求与任务归属不一致")
	}
	if task.ProviderRequestID == "" {
		task.ProviderRequestID = strings.TrimSpace(log.ProviderRequestID)
	}
	result, err := s.queryFailedVideoTask(ctx, task, "")
	if err != nil {
		return nil, err
	}
	if err := s.appendAdminAudit(actor, "api_log.query_provider_task", "task", task.ID, "人工查询失败视频任务", map[string]any{
		"apiCallLogId": log.ID, "providerRequestId": task.ProviderRequestID, "providerStatus": result.ProviderStatus, "recovered": result.Recovered,
	}); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) queryFailedVideoTask(ctx context.Context, task *model.Task, claimUserID string) (*ProviderTaskQueryResult, error) {
	ctx = withProtocolRegistry(ctx, s.protocolRegistry())
	if task == nil || task.ID == "" {
		return nil, BadAuthRequest("任务不存在")
	}
	if task.Status != model.TaskStatusFailed {
		return nil, BadAuthRequest("只能人工查询状态为失败的任务")
	}
	upscale := generation.UpscaleMediaType(task.Model) != ""
	if !strings.HasPrefix(task.Type, "canvas_video") && !strings.HasPrefix(task.Type, "video_") && !upscale {
		return nil, BadAuthRequest("该任务不是视频生成任务")
	}

	s.hydrateTaskProviderRequestID(task)
	providerRequestID := strings.TrimSpace(task.ProviderRequestID)
	if providerRequestID == "" {
		return nil, BadAuthRequest("该任务没有可恢复的上游任务 ID")
	}
	decryptedInput, err := s.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return nil, fmt.Errorf("读取任务配置失败：%w", err)
	}
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(decryptedInput), &input); err != nil {
		return nil, fmt.Errorf("任务输入解析失败：%w", err)
	}
	config, err := s.resolveProviderConfig(input.Config)
	if err != nil {
		return nil, err
	}
	ctx = ensureOfficialProtocolAdapter(ctx, config.InterfaceType)
	adapter, declarative := declarativeProtocolAdapterForContext(ctx, config.InterfaceType)
	beefVideo := isBeefAPIVideoConfig(ctx, config)
	workflowVideo := workflow.IsProviderInterface(config.InterfaceType)
	_, officialVideo := generation.OfficialDeclarativeVideoInterface(config.InterfaceType)
	legacyVideo := !officialVideo && (strings.TrimSpace(config.InterfaceType) == "" || isArkPlanVideoConfig(config))
	if !declarative && !beefVideo && !workflowVideo && !legacyVideo && !upscale {
		return nil, BadAuthRequest("该任务的请求协议不支持安全查询上游状态")
	}
	input.Config = config
	task.InputJSON = decryptedInput
	task.ProviderRequestID = providerRequestID
	if err := s.repo.UpdateTaskProviderState(task.ID, providerRequestID, task.PollStage, task.NextPollAt); err != nil {
		return nil, err
	}

	owner := "manual-recovery:" + newID()
	if err := s.repo.ClaimFailedTaskProviderRecovery(task.ID, claimUserID, owner, providerTaskRecoveryLeaseDuration); err != nil {
		if errors.Is(err, repository.ErrTaskProviderRecoveryConflict) {
			return nil, &AuthError{Status: 409, Message: "该任务正在查询上游状态，请稍后再试"}
		}
		return nil, err
	}
	task.LeaseOwner = owner
	defer func() {
		if releaseErr := s.repo.ReleaseTaskProviderRecovery(task.ID, owner); releaseErr != nil {
			_ = s.log(task.UserID, task.ID, "error", "人工查询租约释放失败", releaseErr.Error())
		}
	}()

	// 上游已成功后的完整媒体下载和本地入库可能持续数十秒。浏览器关闭抽屉、
	// 页面刷新或代理断开都不应中断这项运维恢复，否则任务会再次停在
	// failed/refunded。保留请求值用于审计，但把执行生命周期交给恢复租约控制。
	recoveryCtx, cancelRecovery := providerTaskRecoveryContext(ctx)
	defer cancelRecovery()
	queryCtx := withProviderAnalytics(recoveryCtx, s, *task)
	var result map[string]interface{}
	var providerStatus string
	if upscale {
		result, providerStatus, err = generation.RecoverUpscaleResult(queryCtx, input, providerRequestID)
	} else if beefVideo {
		result, providerStatus, err = queryBeefAPIVideoResult(queryCtx, input, providerRequestID)
	} else if workflowVideo {
		result, providerStatus, err = s.workflowClient(nil).QueryVideo(queryCtx, workflowConfigFromProvider(config), workflow.RootURL(config.BaseURL), providerRequestID)
	} else if !declarative && legacyVideo {
		result, providerStatus, err = generation.QueryHandwrittenVideoTask(queryCtx, input, providerRequestID)
	} else {
		result, providerStatus, err = queryProtocolAdapterVideoTask(queryCtx, input, adapter, providerRequestID)
	}
	if err != nil {
		_ = s.log(task.UserID, task.ID, "error", "人工查询上游视频任务失败", err.Error())
		return nil, err
	}
	if result == nil {
		_ = s.log(task.UserID, task.ID, "info", "人工查询完成，上游任务仍在处理", providerStatus)
		return &ProviderTaskQueryResult{Task: taskForOutput(*task), ProviderStatus: providerStatus, Recovered: false}, nil
	}

	result, err = s.persistTaskGeneratedMediaResult(*task, result)
	if err != nil {
		_ = s.log(task.UserID, task.ID, "error", "人工查询已取得视频，但结果保存失败", err.Error())
		return nil, err
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	task.Error = ""
	task.PollStage = strings.ToLower(providerStatus)
	task.NextPollAt = nil
	if err := s.saveTaskCompletionWithinStorageQuota(task, resultJSON, nil, false); err != nil {
		_ = s.log(task.UserID, task.ID, "error", "人工查询已取得视频，但任务恢复失败", err.Error())
		return nil, err
	}
	if err := s.RegisterTaskOutputFromTask(*task); err != nil {
		_ = s.log(task.UserID, task.ID, "error", "任务恢复成功但项目产物登记失败", err.Error())
		return nil, fmt.Errorf("任务已恢复，但项目素材登记失败：%w", err)
	}
	projected := s.attachRecoveredProviderTask(task)
	_ = s.log(task.UserID, task.ID, "info", "人工查询确认生成成功，任务已恢复并登记项目产物", providerStatus)
	return &ProviderTaskQueryResult{Task: projected, ProviderStatus: providerStatus, Recovered: true}, nil
}

// Query-only: never route recovery through create, even when the original
// persisted channel metadata names the legacy generations protocol.
func queryBeefAPIVideoResult(ctx context.Context, input canvasGenerationInput, id string) (map[string]interface{}, string, error) {
	var state map[string]interface{}
	if err := getJSON(ctx, input.Config, "/videos/"+id, &state); err != nil {
		return nil, "", err
	}
	var err error
	state, err = generation.ValidateVideoTaskState(id, state)
	if err != nil {
		return nil, "", err
	}
	status, videoURL := seedancePollStatusAndURL(state)
	if status == "failed" || status == "cancelled" || status == "expired" {
		return nil, status, errors.New(defaultString(seedanceErrorMessage(state), "视频生成失败"))
	}
	if !generation.VideoTaskSucceeded(status) {
		return nil, status, nil
	}
	if videoURL == "" {
		videoURL = generation.APIURL(input.Config.BaseURL, "/videos/"+id+"/content")
	}
	data, mimeType, err := generation.DownloadVideoResult(ctx, input.Config, videoURL, id)
	if err != nil {
		return nil, status, err
	}
	return map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": dataURL(mimeType, data), "mimeType": mimeType}}, status, nil
}

func providerTaskRecoveryContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(parent), providerTaskRecoveryLeaseDuration)
}
