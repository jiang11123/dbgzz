package app

import (
	"encoding/json"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

func (s *Service) ValidateTaskCapability(input map[string]any) error {
	encoded, err := json.Marshal(input)
	if err != nil {
		return BadAuthRequest("任务输入格式无效")
	}
	var taskInput canvasGenerationInput
	if err := json.Unmarshal(encoded, &taskInput); err != nil {
		return BadAuthRequest("任务参数格式无效，请检查模型设置后重新提交")
	}
	if taskInput.Mode != "image" && taskInput.Mode != "video" && taskInput.Mode != "audio" {
		return nil
	}
	if isWorkflowProviderInterface(taskInput.Config.InterfaceType) {
		if err := validateWorkflowProviderPromptLength(taskInput); err != nil {
			return err
		}
		return validateWorkflowProviderConfig(taskInput.Mode, taskInput.Config)
	}
	validated, err := modelcatalog.ValidateConfiguredTask(taskInputFromCanvas(taskInput), s.channelModelLookup())
	if err != nil {
		return err
	}
	if config, ok := input["config"].(map[string]any); ok {
		config["vquality"] = validated.Config.VQuality
	}
	return nil
}

func (s *Service) channelModelLookup() modelcatalog.ChannelModelLookup {
	return func(channelID, modelKey string) (*model.ChannelModel, error) {
		return s.repo.ChannelModelByKey(channelID, modelKey)
	}
}
