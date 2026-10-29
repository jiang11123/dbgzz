package task

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func IsRetiredAgentOperation(operation string) bool {
	op := strings.TrimSpace(operation)
	return strings.HasPrefix(op, RetiredCloudAgentPrefix) || op == RetiredMemoryCompactOp
}

func IsRetiredAgentTaskInput(operation string, input map[string]any) bool {
	if IsRetiredAgentOperation(operation) {
		return true
	}
	return input != nil && input["cloudAgent"] != nil
}

func RetiredAgentTask(task *model.Task) bool {
	if task == nil {
		return false
	}
	if IsRetiredAgentOperation(task.Operation) {
		return true
	}
	if strings.TrimSpace(task.InputJSON) == "" {
		return false
	}
	var probe struct {
		CloudAgent json.RawMessage `json:"cloudAgent"`
	}
	if err := json.Unmarshal([]byte(task.InputJSON), &probe); err != nil {
		return false
	}
	marker := strings.TrimSpace(string(probe.CloudAgent))
	return marker != "" && marker != "null"
}

func ClientOperationID(input map[string]any) (string, error) {
	metadata, _ := input["metadata"].(map[string]any)
	if metadata == nil {
		return "", nil
	}
	raw, ok := metadata["clientOperationId"]
	if !ok || raw == nil {
		return "", nil
	}
	value, ok := raw.(string)
	if !ok {
		return "", kernel.BadAuthRequest("clientOperationId 必须是字符串")
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if len(value) < 8 || len(value) > 128 || strings.ContainsFunc(value, func(r rune) bool {
		return !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == ':' || r == '_' || r == '-')
	}) {
		return "", kernel.BadAuthRequest("clientOperationId 格式无效")
	}
	return value, nil
}

func ClientOperationHash(req CreateRequest) (string, error) {
	req.Prompt = strings.TrimSpace(req.Prompt)
	req.Type = strings.TrimSpace(req.Type)
	req.ProjectID = strings.TrimSpace(req.ProjectID)
	encoded, err := json.Marshal(req)
	if err != nil {
		return "", kernel.BadAuthRequest("任务输入格式无效")
	}
	return fmt.Sprintf("%x", sha256.Sum256(encoded)), nil
}

func NormalizeInput(input map[string]any) (map[string]any, error) {
	if input == nil {
		return map[string]any{}, nil
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return nil, kernel.BadAuthRequest("任务输入格式无效")
	}
	var normalized map[string]any
	if err := json.Unmarshal(encoded, &normalized); err != nil {
		return nil, kernel.BadAuthRequest("任务输入格式无效")
	}
	if snapshot, ok := normalized["canvasSnapshot"]; ok {
		normalized["canvasSnapshot"] = compactPersistedValue(snapshot)
	}
	return normalized, nil
}

func ValidateType(taskType string) error {
	switch taskType {
	case "text", "canvas_text", "canvas_image", "canvas_video", "canvas_audio":
		return nil
	}
	if strings.HasPrefix(taskType, "video_") && strings.TrimPrefix(taskType, "video_") != "" {
		return nil
	}
	if taskType == "" {
		return errors.New("task type is required")
	}
	return fmt.Errorf("不支持的任务类型：%s", taskType)
}

func ValidateLocalExecutorType(taskType string) error {
	switch taskType {
	case model.TaskTypeTimelineTranscription, model.TaskTypeTimelineRender, model.TaskTypeDepthCapture, model.TaskTypeCanvasMediaTransform:
		return nil
	}
	if taskType == "" {
		return errors.New("task type is required")
	}
	return fmt.Errorf(UnsupportedLocalExecutorTypeMessageFmt, taskType)
}

func compactPersistedValue(value interface{}) interface{} {
	switch item := value.(type) {
	case map[string]interface{}:
		result := make(map[string]interface{}, len(item))
		for key, child := range item {
			if text, ok := child.(string); ok && strings.HasPrefix(text, "data:") {
				result[key] = ""
				continue
			}
			result[key] = compactPersistedValue(child)
		}
		return result
	case []interface{}:
		result := make([]interface{}, len(item))
		for index, child := range item {
			result[index] = compactPersistedValue(child)
		}
		return result
	default:
		return value
	}
}

func (s *Service) validateRetryType(userID, taskType string, input map[string]any) error {
	metadata, _ := input["metadata"].(map[string]any)
	raw, ok := metadata["retryOf"]
	if !ok || raw == nil {
		return nil
	}
	value, ok := raw.(string)
	if !ok {
		return kernel.BadAuthRequest("retryOf 必须是字符串")
	}
	retryOf := strings.TrimSpace(value)
	if retryOf == "" {
		return nil
	}
	if s.store == nil {
		return kernel.BadAuthRequest("找不到原始重试任务")
	}
	parent, err := s.store.TaskForUser(userID, retryOf)
	if err != nil {
		return kernel.BadAuthRequest("找不到原始重试任务")
	}
	if parent.Type != taskType {
		return kernel.BadAuthRequest(fmt.Sprintf("重试任务类型不一致：原任务为 %s，新任务为 %s", parent.Type, taskType))
	}
	if s.deps.Images == nil {
		return unavailable()
	}
	return s.deps.Images.ValidateRetry(parent)
}

func admitExisting(existing model.Task, req CreateRequest, present Presenter) (*model.Task, error) {
	fingerprint, err := ClientOperationHash(req)
	if err != nil {
		return nil, err
	}
	if existing.ClientOperationHash == "" || existing.ClientOperationHash != fingerprint {
		return nil, kernel.NewAppError(kernel.CodeConflict, ClientOperationConflictMessage)
	}
	return presentTask(present, existing)
}
