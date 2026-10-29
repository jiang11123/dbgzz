package app

import (
	"encoding/json"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// TaskSummary 是任务列表/会话详情的读模型，不直接复用数据库 Task，避免把
// 渠道模型、供应线路和受保护输入泄露到普通用户接口。
type TaskSummary = localtask.Summary

type TaskClientContext = localtask.ClientContext

func taskSummariesForOutput(tasks []model.Task) []TaskSummary {
	result := make([]TaskSummary, 0, len(tasks))
	for _, task := range tasks {
		result = append(result, taskSummaryForOutput(task))
	}
	return result
}

func taskSummaryForOutput(task model.Task) TaskSummary {
	task = correctPersistedVODParameterFailure(task)
	errorCode := persistedFailureErrorCode(task.Error, task.Stage)
	if errorCode == string(generation.CategoryUnknown) && !isContentModerationFailure(task.Error) {
		errorCode = ""
	}
	if isContentModerationFailure(task.Error) && errorCode == "" {
		errorCode = contentModerationErrorCode
	}
	previewURL, previewKind, previewPosterURL := taskMediaPreviewWithPoster(task.ResultJSON, task.Type)
	return TaskSummary{
		ID:                        task.ID,
		ProjectID:                 task.ProjectID,
		Type:                      task.Type,
		Status:                    task.Status,
		Stage:                     task.Stage,
		Progress:                  task.Progress,
		Prompt:                    truncateRunes(task.Prompt, 500),
		Operation:                 task.Operation,
		Provider:                  task.Provider,
		Model:                     task.Model,
		ProviderRequestID:         task.ProviderRequestID,
		ProviderCancelStatus:      task.ProviderCancelStatus,
		ProviderCancelError:       task.ProviderCancelError,
		ProviderCancelAttempts:    task.ProviderCancelAttempts,
		ProviderCancelRequestedAt: task.ProviderCancelRequestedAt,
		ProviderCancelledAt:       task.ProviderCancelledAt,
		Error:                     safePersistedFailureMessage(task.Error, task.Stage),
		ErrorCode:                 errorCode,
		FailureDiagnostics:        generation.SanitizeTaskDiagnostics(task.FailureDiagnostics),
		PreviewURL:                previewURL,
		PreviewKind:               previewKind,
		PreviewPosterURL:          previewPosterURL,
		Attempts:                  task.Attempts,
		StartedAt:                 task.StartedAt,
		CompletedAt:               task.CompletedAt,
		CreatedAt:                 task.CreatedAt,
		UpdatedAt:                 task.UpdatedAt,
		ClientContext:             taskClientContext(task.InputJSON),
	}
}

// 列表只暴露页面恢复所需的非敏感关联 ID，不下发完整任务输入或其他 metadata。
func taskClientContext(raw string) *TaskClientContext {
	var input struct {
		Metadata struct {
			Source          string `json:"source"`
			SceneID         string `json:"sceneId"`
			NodeID          string `json:"nodeId"`
			ConversationID  string `json:"conversationId"`
			MessageID       string `json:"messageId"`
			BatchIndex      int    `json:"batchIndex"`
			BatchCount      int    `json:"batchCount"`
			DomainProjectID string `json:"domainProjectId"`
			ChapterID       string `json:"chapterId"`
			Operation       string `json:"operation"`
			ShotID          string `json:"shotId"`
			WorkflowStepID  string `json:"workflowStepId"`
			ArtifactType    string `json:"artifactType"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(raw), &input) != nil {
		return nil
	}
	metadata := input.Metadata
	context := &TaskClientContext{NodeID: metadata.NodeID}
	if metadata.Source == "director-panorama" && metadata.SceneID != "" {
		context.Source = metadata.Source
		context.SceneID = metadata.SceneID
		return context
	}
	if metadata.Source == "create-page" && metadata.ConversationID != "" && metadata.MessageID != "" {
		context.ConversationID = metadata.ConversationID
		context.MessageID = metadata.MessageID
		context.BatchIndex = metadata.BatchIndex
		context.BatchCount = metadata.BatchCount
		return context
	}
	if metadata.ShotID != "" && metadata.WorkflowStepID != "" {
		context.DomainProjectID = metadata.DomainProjectID
		context.ShotID = metadata.ShotID
		context.WorkflowStepID = metadata.WorkflowStepID
		context.ArtifactType = metadata.ArtifactType
		return context
	}
	chapterOperation := ""
	if metadata.Operation == "chapter_character_breakdown" {
		chapterOperation = "characters"
	} else if metadata.Source == "short-drama-chapter-storyboard" {
		chapterOperation = "storyboard"
	}
	if chapterOperation == "" || metadata.DomainProjectID == "" || metadata.ChapterID == "" {
		if context.NodeID == "" {
			return nil
		}
		return context
	}
	context.DomainProjectID = metadata.DomainProjectID
	context.ChapterID = metadata.ChapterID
	context.ChapterOperation = chapterOperation
	return context
}

// 列表只暴露首个可访问媒体地址，避免把完整生成结果和内嵌数据带回前端。
func taskMediaPreview(raw string, taskType string) (string, string) {
	previewURL, previewKind, _ := taskMediaPreviewWithPoster(raw, taskType)
	return previewURL, previewKind
}

func taskMediaPreviewWithPoster(raw string, taskType string) (string, string, string) {
	if strings.TrimSpace(raw) == "" {
		return "", "", ""
	}
	var payload any
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return "", "", ""
	}
	defaultKind := "image"
	if strings.Contains(strings.ToLower(taskType), "video") {
		defaultKind = "video"
	}
	previewURL, previewKind := findTaskMediaPreview(payload, defaultKind)
	posterURL := findTaskMediaPoster(payload)
	if previewKind == "image" && posterURL == "" {
		posterURL = previewURL
	}
	return previewURL, previewKind, posterURL
}

func findTaskMediaPoster(value any) string {
	switch item := value.(type) {
	case []any:
		for _, child := range item {
			if posterURL := findTaskMediaPoster(child); posterURL != "" {
				return posterURL
			}
		}
	case map[string]any:
		for _, key := range []string{"posterUrl", "posterURL", "thumbnailUrl", "thumbnailURL", "coverUrl", "coverURL", "poster", "thumbnail", "cover"} {
			child, exists := item[key]
			if !exists {
				continue
			}
			if previewURL, previewKind := findTaskMediaPreview(child, "image"); previewURL != "" && previewKind == "image" {
				return previewURL
			}
		}
		for _, child := range item {
			if posterURL := findTaskMediaPoster(child); posterURL != "" {
				return posterURL
			}
		}
	}
	return ""
}

func findTaskMediaPreview(value any, hint string) (string, string) {
	switch item := value.(type) {
	case string:
		text := strings.TrimSpace(item)
		if !isResourceFileURL(text) && !strings.HasPrefix(text, "http://") && !strings.HasPrefix(text, "https://") {
			return "", ""
		}
		kind := hint
		lower := strings.ToLower(text)
		if strings.Contains(lower, ".mp4") || strings.Contains(lower, ".webm") || strings.Contains(lower, ".mov") {
			kind = "video"
		} else if kind != "video" {
			kind = "image"
		}
		return text, kind
	case []any:
		for _, child := range item {
			if previewURL, previewKind := findTaskMediaPreview(child, hint); previewURL != "" {
				return previewURL, previewKind
			}
		}
	case map[string]any:
		for _, key := range []string{"images", "image", "video", "dataUrl", "url", "resultUrl", "outputUrl"} {
			child, exists := item[key]
			if !exists {
				continue
			}
			childHint := hint
			if key == "video" {
				childHint = "video"
			} else if key == "images" || key == "image" {
				childHint = "image"
			}
			if previewURL, previewKind := findTaskMediaPreview(child, childHint); previewURL != "" {
				return previewURL, previewKind
			}
		}
	}
	return "", ""
}

func truncateRunes(value string, limit int) string {
	return kernel.TruncateRunes(value, limit)
}

func taskForOutput(task model.Task) *model.Task {
	task = correctPersistedVODParameterFailure(task)
	task.FailureDiagnostics = generation.SanitizeTaskDiagnostics(task.FailureDiagnostics)
	task.InputJSON = publicTaskInputJSON(task.InputJSON)
	// 普通任务接口只暴露前台模型身份；渠道模型和供应线路属于管理员内部信息。
	task.LogicalModelRevisionID = ""
	task.RouteID = ""
	task.ChannelModelID = ""
	task.ErrorCode = persistedFailureErrorCode(task.Error, task.Stage)
	if task.ErrorCode == string(generation.CategoryUnknown) && !isContentModerationFailure(task.Error) {
		task.ErrorCode = ""
	}
	task.Error = safePersistedFailureMessage(task.Error, task.Stage)
	return &task
}

func safePersistedFailureMessage(message, stage string) string {
	if strings.TrimSpace(message) == "" {
		return ""
	}
	if stage == "submission_unknown" {
		return (generation.Failure{Category: generation.CategorySubmissionUncertain}).UserMessage()
	}
	return generation.ClassifyText(message).UserMessage()
}

func publicTaskInputJSON(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		return ""
	}
	public := map[string]any{}
	// Only expose the parameters needed for result comparison and paid retry
	// confirmation. Never expose credentials, headers, media URLs or bytes.
	if input["mode"] == "video" {
		config, _ := input["config"].(map[string]any)
		counts := func(key string) int { items, _ := input[key].([]any); return len(items) }
		parameters := map[string]any{"imageCount": counts("referenceImages"), "videoCount": counts("referenceVideos"), "audioCount": counts("referenceAudios")}
		for _, key := range []string{"model", "size"} {
			if value, ok := config[key].(string); ok {
				parameters[key] = value
			}
		}
		base, _ := config["baseUrl"].(string)
		u, _ := url.Parse(base)
		host := ""
		if u != nil {
			host = strings.ToLower(u.Hostname())
		}
		parameters["affectedChannel"] = config["credentialRef"] == "beefapi-enterprise" || host == "beeftv.app" || host == "enterprise.beefapi.com" || host == "whatstoken.ai" || host == "www.whatstoken.ai"
		public["videoParameters"] = parameters
	}
	// 任务完成后仍需依靠这些非敏感 ID 恢复项目产物归属；密钥等配置继续被过滤。
	for _, key := range []string{"mode", "metadata", "workflowStepId", "domainProjectId", "assetVersionId", "resourceId", "mediaType", "role"} {
		if value, ok := input[key]; ok {
			public[key] = value
		}
	}
	if len(public) == 0 {
		return ""
	}
	data, _ := json.Marshal(public)
	return string(data)
}

// Read-time projection repairs an old uncertainty label only when one complete
// recorded HTTP response proves a structured parameter failure. Raw history stays intact.
func correctPersistedVODParameterFailure(task model.Task) model.Task {
	d := task.FailureDiagnostics
	if task.Type != "canvas_image" || task.Status != model.TaskStatusFailed || task.Stage != "submission_unknown" || d == nil || d.OmittedRequests != 0 || len(d.Requests) != 1 {
		return task
	}
	r := d.Requests[0]
	if !r.Dispatched || r.Outcome != "http_error" || r.HTTPStatus != 400 || r.ProviderCode != d.ProviderCode || d.HTTPStatus != 400 || (r.ProviderCode != "vod_image_invalid_params" && r.ProviderCode != "vod_image_invalid_media") {
		return task
	}
	raw, _ := json.Marshal(map[string]any{"error": map[string]string{"code": r.ProviderCode}})
	failure := generation.ClassifyError(providerHTTPError{StatusCode: 400, Body: string(raw)})
	task.Stage = "生成失败"
	task.Error = failure.UserMessage()
	task.FailureDiagnostics = generation.SanitizeTaskDiagnostics(d)
	task.FailureDiagnostics.Summary = failure.UserMessage()
	task.FailureDiagnostics.Stage = task.Stage
	return task
}
