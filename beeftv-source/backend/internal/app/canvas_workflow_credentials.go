package app

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/workspace"
)

// The private recipe freezes generation parameters, while channel identity
// resolves credentials at the time of a new submission. Deleted connections
// cannot be resurrected by an encrypted historical task key.
func (s *Service) canvasWorkflowProviderConfig() (map[string]any, error) {
	store, e := workspace.NewProviderConfig(s.dataDir)
	if e != nil {
		return nil, e
	}
	effective, _, e := store.LoadEffectiveModelConfig()
	if e != nil {
		return nil, workflowBad("本地模型配置不可读，请在设置中恢复配置后再运行工作流")
	}
	return effective.Config, nil
}

// Refresh only an unaccepted, retryable submission. Accepted provider jobs,
// uncertain submissions and successful deliveries keep their original receipt
// and credential identity so the ordinary recovery path can reconcile them.
func (s *Service) prepareCanvasWorkflowRetryCredentials(run model.CanvasWorkflowRun, nodeID string, task *model.Task) (string, error) {
	if !s.IsLocalMode() || task == nil || (task.Status != model.TaskStatusFailed && task.Status != model.TaskStatusCancelled) || task.ProviderRequestID != "" || task.PollStage != "" || task.NextPollAt != nil || task.Stage == "submission_unknown" {
		return "", nil
	}
	authFailure := generation.ClassifyText(task.Error).Category == generation.CategoryAuth
	if persistedFailureBlocksRetry(task.Error, task.Stage) && !authFailure {
		return "", nil
	}
	if task.Type == "canvas_image" {
		if s.validateImageTaskRetry(task) != nil {
			return "", nil
		}
		receipt, err := s.repo.ImageCreateReceipt(task.UserID, task.ID)
		if err != nil {
			return "", err
		}
		if receipt != nil && receipt.StatusCode < 300 {
			return "", nil
		}
	}
	plain, err := s.decryptSettingSecret(run.RecipeCipher)
	if err != nil {
		return "", workflowBad("无法读取工作流配方，请先恢复工作区密钥")
	}
	var recipes workflowRecipes
	if json.Unmarshal([]byte(plain), &recipes) != nil {
		return "", workflowBad("工作流配方无法读取，请重新保存模板")
	}
	recipe, ok := recipes[nodeID]
	if !ok || recipe.ChannelID == "" {
		return "", nil
	}
	decoded, err := s.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return "", workflowBad("原任务配方无法解密，请先恢复工作区密钥")
	}
	var input map[string]any
	if json.Unmarshal([]byte(decoded), &input) != nil || input == nil {
		return "", workflowBad("原任务配方无法读取，请重新保存模板")
	}
	previousCredentials := canvasWorkflowCredentialFingerprint(input)
	if err = s.refreshCanvasWorkflowCredentials(input, recipe.ChannelID); err != nil {
		return "", err
	}
	if previousCredentials == canvasWorkflowCredentialFingerprint(input) {
		if authFailure {
			return "", workflowBad("此步骤上次鉴权失败，当前连接凭据尚未更新，请在设置中修正 API Key 后再重试")
		}
		return "", nil
	}
	if err = s.protectTaskSecrets(input); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(input)
	return string(encoded), err
}

func canvasWorkflowCredentialFingerprint(input map[string]any) string {
	config, _ := input["config"].(map[string]any)
	credentials := map[string]any{}
	for _, key := range []string{"apiKey", "secretKey", "headers", "baseUrl", "credentialRef", "runningHubUploadApiKey"} {
		if value, ok := config[key]; ok {
			credentials[key] = value
		}
	}
	encoded, _ := json.Marshal(credentials)
	return string(encoded)
}
func (s *Service) canvasWorkflowChannelID(input map[string]any, logical string) (string, error) {
	if !s.IsLocalMode() || logical != "" {
		return "", nil
	}
	config, _ := input["config"].(map[string]any)
	if config == nil {
		return "", workflowBad("原生成步骤缺少模型配置")
	}
	if taskInputUsesWorkflowProvider(input) {
		return "@runninghub", nil
	}
	if beefapi.IsManagedChannel(stringValue(config["channelId"]), stringValue(config["credentialRef"]), stringValue(config["baseUrl"])) {
		return "@beefapi", nil
	}
	snapshot, e := s.canvasWorkflowProviderConfig()
	if e != nil {
		return "", e
	}
	body, _ := json.Marshal(snapshot)
	model := stringValue(config["model"])
	base := strings.TrimRight(stringValue(config["baseUrl"]), "/")
	selected := stringValue(config["channelId"])
	ids := map[string]bool{}
	for _, candidate := range modelcatalog.ParseLocalChannelModels(body) {
		if candidate.Model == model && strings.TrimRight(candidate.BaseURL, "/") == base && candidate.Enabled && (selected == "" || candidate.ChannelID == selected) {
			ids[candidate.ChannelID] = true
		}
	}
	if len(ids) != 1 {
		return "", workflowBad("无法唯一找到原生成步骤的可用渠道，请在设置中启用原模型渠道并重新手动运行该节点")
	}
	for id := range ids {
		return id, nil
	}
	return "", nil
}
func (s *Service) refreshCanvasWorkflowCredentials(input map[string]any, channelID string) error {
	if !s.IsLocalMode() || channelID == "" {
		return nil
	}
	config, _ := input["config"].(map[string]any)
	if config == nil {
		return workflowBad("生成步骤的模型配置缺失")
	}
	if channelID == "@beefapi" {
		key, base, _, _, e := s.lookupBeefAPICredential()
		if e != nil {
			return e
		}
		if key == "" {
			return workflowBad("BeefAPI 连接已断开，请先在设置中重新连接")
		}
		config["apiKey"] = key
		config["baseUrl"] = base
		config["credentialRef"] = managedBeefAPIRef
		config["secretKey"] = ""
		config["headers"] = []any{}
		delete(config, "channelId")
		return nil
	}
	snapshot, e := s.canvasWorkflowProviderConfig()
	if e != nil {
		return e
	}
	if channelID == "@runninghub" {
		current, _ := snapshot["runningHub"].(map[string]any)
		enabled, _ := current["enabled"].(bool)
		if !enabled || strings.TrimSpace(stringValue(current["apiKey"])) == "" {
			return workflowBad("RunningHub 工作流配置已停用或缺少密钥，请在设置中恢复")
		}
		config["apiKey"] = current["apiKey"]
		config["baseUrl"] = current["baseUrl"]
		config["runningHubUploadApiKey"] = stringValue(current["uploadApiKey"])
		config["secretKey"] = ""
		config["headers"] = []any{}
		return nil
	}
	channels, _ := snapshot["channels"].([]any)
	var current map[string]any
	for _, raw := range channels {
		item, _ := raw.(map[string]any)
		if stringValue(item["id"]) == channelID {
			current = item
			break
		}
	}
	if current == nil {
		return workflowBad("工作流使用的模型渠道已删除，请恢复渠道或重新保存工作流")
	}
	if enabled, ok := current["enabled"].(bool); ok && !enabled {
		return workflowBad("工作流使用的模型渠道已停用，请先在设置中启用")
	}
	body, _ := json.Marshal(snapshot)
	model := stringValue(config["model"])
	found := false
	for _, candidate := range modelcatalog.ParseLocalChannelModels(body) {
		if candidate.ChannelID == channelID && candidate.Model == model && candidate.Enabled {
			found = true
			if candidate.Protocol != "" && candidate.Protocol != stringValue(config["interfaceType"]) {
				return workflowBad("工作流模型的协议已改变，请手动运行节点后重新保存工作流")
			}
		}
	}
	if !found {
		return workflowBad("工作流使用的模型已从渠道移除，请恢复模型或重新保存工作流")
	}
	for _, key := range []string{"apiKey", "secretKey", "headers", "baseUrl", "referenceAssetOrigin"} {
		if value, ok := current[key]; ok {
			config[key] = value
		} else {
			delete(config, key)
		}
	}
	return nil
}
