package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
)

const timelineRenderFileName = "timeline-render.mp4"

func timelineRenderArtifactIdentity(taskID string) string {
	return strings.TrimSpace(taskID) + ":0"
}

func (w *taskWorkerCoordinator) processTimelineRender(task *model.Task, ctx context.Context) error {
	s := w.service
	var input timelineRenderInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return w.failTimelineTask(task, "渲染失败", "任务缺少有效的时间线快照")
	}
	plan, err := editing.Compile(input.Timeline, nil, input.Options)
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	var (
		renderCleanup func()
		renderFile    *os.File
	)
	defer func() {
		if renderFile != nil {
			_ = renderFile.Close()
		}
		if renderCleanup != nil {
			renderCleanup()
		}
	}()
	resource, err := s.resourceDomain().RecoverOwned(task.UserID, timelineRenderArtifactIdentity(task.ID), func() (localasset.RecoveredArtifact, error) {
		rendered, cleanup, renderErr := s.nativeRenderer(task.UserID).Render(ctx, plan, func(stage string, percent int) error {
			return w.progress(task, stage, percent)
		})
		renderCleanup = cleanup
		if renderErr != nil {
			return localasset.RecoveredArtifact{}, renderErr
		}
		file, openErr := os.Open(rendered.Path)
		if openErr != nil {
			return localasset.RecoveredArtifact{}, fmt.Errorf("读取渲染产物失败")
		}
		renderFile = file
		return localasset.RecoveredArtifact{
			Kind: "video", FileName: timelineRenderFileName, MimeType: "video/mp4",
			Size: rendered.Size, Width: rendered.Width, Height: rendered.Height,
			DurationMs: rendered.DurationMs, Body: file,
		}, nil
	})
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	if resource == nil {
		return w.failTimelineTask(task, "渲染失败", "保存渲染产物失败")
	}
	if err := w.progress(task, "写入资源…", 85); err != nil {
		return err
	}

	result := timelineRenderResult{
		Video:       map[string]any{"resourceId": resource.ID, "mimeType": "video/mp4", "fileName": timelineRenderFileName, "durationMs": resource.DurationMs},
		ResourceID:  resource.ID,
		FileName:    timelineRenderFileName,
		Size:        resource.Size,
		DurationMs:  resource.DurationMs,
		SubtitleSRT: plan.SubtitleSRT,
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", "渲染结果序列化失败")
	}
	task.Status = model.TaskStatusSucceeded
	task.Stage = "渲染完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	if err := s.repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return fmt.Errorf("写入渲染完成态失败: %w", err)
	}
	if err := s.DeliverSucceededTask(*task); err != nil {
		return fmt.Errorf("本地渲染完成后的素材交付失败：%w", err)
	}
	s.logInfo(task.UserID, task.ID, fmt.Sprintf("时间线渲染完成，时长 %.1fs", float64(resource.DurationMs)/1000), "")
	return nil
}
