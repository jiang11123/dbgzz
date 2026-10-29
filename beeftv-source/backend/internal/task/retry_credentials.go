package task

import (
	"encoding/json"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

type retryCredentialRefresh struct {
	expectedInputJSON string
	inputJSON         string
}
type credentialRetryStore interface {
	RetryWithExpectedInput(userID string, prepared *model.Task, limit int, expectedInputJSON string) (*model.Task, error)
}

func (s *Service) validateRetryCredentialRefresh(task *model.Task, refresh retryCredentialRefresh) error {
	if task.InputJSON != refresh.expectedInputJSON || task.ProviderRequestID != "" || task.PollStage != "" || task.NextPollAt != nil || task.Stage == "submission_unknown" {
		return kernel.BadAuthRequest("原任务已被接纳或状态发生变化，请先查询原任务，避免重复生成")
	}
	previous, err := s.deps.Secrets.DecryptInputJSON(task.InputJSON)
	if err != nil {
		return err
	}
	next, err := s.deps.Secrets.DecryptInputJSON(refresh.inputJSON)
	if err != nil {
		return err
	}
	var before, after map[string]any
	if json.Unmarshal([]byte(previous), &before) != nil || json.Unmarshal([]byte(next), &after) != nil || before == nil || after == nil {
		return kernel.BadAuthRequest("原任务配方格式无效")
	}
	credentials := []string{}
	for _, input := range []map[string]any{before, after} {
		config, _ := input["config"].(map[string]any)
		if config == nil {
			return kernel.BadAuthRequest("原任务缺少渠道配置")
		}
		connection := map[string]any{}
		for _, key := range []string{"apiKey", "secretKey", "headers", "baseUrl", "credentialRef", "referenceAssetOrigin", "runningHubUploadApiKey"} {
			if value, ok := config[key]; ok {
				connection[key] = value
			}
			delete(config, key)
		}
		encoded, _ := json.Marshal(connection)
		credentials = append(credentials, string(encoded))
	}
	if credentials[0] == credentials[1] {
		return kernel.BadAuthRequest("连接凭据尚未更新，请先在设置中修正后重试")
	}
	beforeJSON, _ := json.Marshal(before)
	afterJSON, _ := json.Marshal(after)
	if string(beforeJSON) != string(afterJSON) {
		return kernel.BadAuthRequest("凭据刷新不能更改原任务内容，请重新运行工作流")
	}
	return nil
}
