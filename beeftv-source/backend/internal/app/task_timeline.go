package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/transcription"
)

type timelineTranscriptionInput = localtask.TimelineTranscriptionInput

func (w *taskWorkerCoordinator) processTimelineTranscription(task *model.Task, ctx context.Context) error {
	s := w.service
	baseURL := strings.TrimSpace(os.Getenv(transcription.BaseURLEnv))
	var input timelineTranscriptionInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil || strings.TrimSpace(input.ResourceID) == "" {
		return w.failTimelineTask(task, "转写失败", "任务缺少有效的资源引用")
	}
	if input.Model == "" && baseURL == "" {
		return w.failTimelineTask(task, "转写失败", "未配置本地转写服务：请设置 CANVAS_WHISPER_BASE_URL 指向 whisper.cpp 服务")
	}
	if err := s.RequireFeature(FeatureTimelineTranscription); err != nil {
		return w.failTimelineTask(task, "转写失败", "字幕转写暂未开放")
	}
	s.logInfo(task.UserID, task.ID, "时间线转写任务开始", "")
	executor := s.transcriptionExecutor(task.UserID, baseURL)
	if input.Model != "" {
		// A synchronous paid upload has no recoverable upstream task ID. Never
		// resubmit a reclaimed lease or a generic task retry with uncertain receipt.
		if task.Attempts > 1 {
			return w.failTimelineTask(task, "转写已中断", "上次云端转写结果未确认，未重复提交。请检查原任务和用量后重新创建转写")
		}
		if s.beefAPI == nil {
			return w.failTimelineTask(task, "转写失败", "请先连接 BeefTV")
		}
		cred, err := s.beefAPI.Resolve()
		if err != nil || input.ManagedTokenID == "" || cred.TokenID != input.ManagedTokenID {
			return w.failTimelineTask(task, "转写失败", "BeefTV 连接已改变，请重新提交转写")
		}
		executor.Client = transcription.NewClient(cred.BaseURL)
		if _, err := outbound.ValidateOutboundURL(cred.BaseURL); err != nil {
			return w.failTimelineTask(task, "转写失败", "云端转写地址不可用，请重新连接 BeefTV")
		}
		executor.Client.HTTP = outbound.OutboundHTTPClient(20 * time.Minute)
		executor.Client.Model, executor.Client.APIKey = input.Model, cred.APIKey
	}
	result, err := executor.Run(ctx, input.ResourceID, input.Language, func(stage string, percent int) error {
		return w.progress(task, stage, percent)
	})
	if err != nil {
		return w.failTimelineTask(task, "转写失败", err.Error())
	}

	payload, err := json.Marshal(result)
	if err != nil {
		return w.failTimelineTask(task, "转写失败", "转写结果序列化失败")
	}
	task.Status = model.TaskStatusSucceeded
	task.Stage = "转写完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	if err := s.repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return fmt.Errorf("写入转写完成态失败: %w", err)
	}
	s.logInfo(task.UserID, task.ID, fmt.Sprintf("时间线转写完成，段落 %d", len(result.Segments)), "")
	return nil
}

func (w *taskWorkerCoordinator) failTimelineTask(task *model.Task, stage string, message string) error {
	s := w.service
	done, err := s.repo.UpdateTaskTerminalState(task.ID, task.LeaseOwner, model.TaskStatusRunning, model.TaskStatusFailed, stage, message, time.Now(), task.FailureDiagnostics)
	if err != nil {
		return fmt.Errorf("写入转写失败态失败: %w", err)
	}
	if !done {
		return fmt.Errorf("时间线任务状态或租约已变化：%w", repository.ErrTaskStateConflict)
	}
	label := "时间线转写失败"
	if task.Type == model.TaskTypeDepthCapture {
		label = "深度处理失败"
	}
	s.logInfo(task.UserID, task.ID, fmt.Sprintf("%s: %s", label, message), "")
	return nil
}

func (w *taskWorkerCoordinator) progress(task *model.Task, stage string, progress int) error {
	if err := w.service.repo.UpdateTaskProgressForLease(task.ID, task.LeaseOwner, stage, progress); err != nil {
		return fmt.Errorf("更新转写进度失败: %w", err)
	}
	return nil
}

func (s *Service) logInfo(userID string, taskID string, message string, extra string) {
	s.log(userID, taskID, "info", message, extra)
}

type TimelineTranscriptionCreateRequest = localtask.TimelineTranscriptionCreateRequest

func (s *Service) CreateTimelineTranscriptionTask(userID string, req TimelineTranscriptionCreateRequest) (*model.Task, error) {
	return s.taskDomain().CreateTimelineTranscriptionTask(userID, req)
}

func (s *Service) bindTranscriptionModel(modelID string) (string, error) {
	if s.beefAPI == nil {
		return "", BadAuthRequest("请先连接 BeefTV")
	}
	cred, err := s.beefAPI.Resolve()
	if err != nil {
		return "", BadAuthRequest(err.Error())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	models, err := s.beefAPI.RefreshCatalog(ctx)
	if err != nil {
		return "", BadAuthRequest(err.Error())
	}
	available := false
	for _, model := range models {
		if model.ID == modelID {
			for _, endpoint := range model.SupportedEndpointTypes {
				if endpoint == "audio.transcriptions" {
					available = true
				}
			}
		}
	}
	if !available {
		return "", BadAuthRequest("该模型不支持音视频转写，请刷新模型列表")
	}
	next, err := s.beefAPI.Resolve()
	if err != nil || next.TokenID != cred.TokenID || next.AccountID != cred.AccountID {
		return "", BadAuthRequest("BeefTV 连接已改变，请重新提交转写")
	}
	return cred.TokenID, nil
}

type TimelineRenderCreateRequest = localtask.TimelineRenderCreateRequest

type timelineRenderInput struct {
	ProjectID string          `json:"projectId"`
	Timeline  editing.Project `json:"timeline"`
	Options   editing.Options `json:"options"`
}

type TimelineRenderPlanRequest struct {
	Timeline editing.Project      `json:"timeline"`
	Sources  []editing.SourceMeta `json:"sources"`
	Options  editing.Options      `json:"options"`
}

type timelineRenderResult struct {
	Video       map[string]any `json:"video,omitempty"`
	ResourceID  string         `json:"resourceId"`
	FileName    string         `json:"fileName"`
	Size        int64          `json:"size"`
	DurationMs  int64          `json:"durationMs"`
	SubtitleSRT string         `json:"subtitleSrt,omitempty"`
}

func (s *Service) CreateTimelineRenderTask(userID string, req TimelineRenderCreateRequest) (*model.Task, error) {
	return s.taskDomain().CreateTimelineRenderTask(userID, req)
}

func (s *Service) CompileTimelineRenderPlan(userID string, req TimelineRenderPlanRequest) (*editing.Plan, error) {
	if strings.TrimSpace(userID) == "" {
		return nil, Unauthorized("未登录")
	}
	plan, err := editing.Compile(req.Timeline, req.Sources, req.Options)
	if err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	return plan, nil
}
