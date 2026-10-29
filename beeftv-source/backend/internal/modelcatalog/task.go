package modelcatalog

import (
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

// ValidateConfiguredTask applies stored channel capability to a task. Workflow
// providers are handled by the caller. lookup may be nil when no channel is
// selected; the function then validates against request-declared capability.
func ValidateConfiguredTask(input TaskInput, lookup ChannelModelLookup) (TaskInput, error) {
	if input.Mode != "image" && input.Mode != "video" && input.Mode != "audio" {
		return input, nil
	}
	if input.Mode == "audio" {
		return input, nil
	}
	channelID := strings.TrimSpace(input.Config.ChannelID)
	if channelID == "" {
		channelID = SystemChannelIDFromBaseURL(input.Config.BaseURL)
	}
	if channelID == "" {
		if input.Mode == "image" {
			profile := DefaultImageCapabilityConfig(input.Config.InterfaceType, input.Config.Model)
			if input.Config.CapabilityConfig != nil && input.Config.CapabilityConfig.Image != nil {
				profile = input.Config.CapabilityConfig.Image
			}
			return input, validateImageTask(profile, input)
		}
		profile := input.Config.CapabilityConfig
		if profile == nil || profile.Video == nil {
			if input.Config.InterfaceType != string(model.ChannelInterfaceAgnesVideo) {
				return input, nil
			}
			profile = DefaultModelCapabilityConfigForModel(input.Config.InterfaceType, input.Config.Model)
		}
		normalized, normalizeErr := NormalizeModelCapabilityConfigForModel("video", input.Config.InterfaceType, input.Config.Model, profile)
		if normalizeErr != nil || normalized == nil || normalized.Video == nil {
			return input, kernel.BadAuthRequest("当前视频模型能力参数无效")
		}
		return input, validateVideoTask(normalized.Video, input)
	}
	if lookup == nil {
		return input, kernel.BadAuthRequest("当前系统渠道模型未配置或已停用")
	}
	item, err := lookup(channelID, ProviderChannelModelKey(input.Config.ChannelModelKey, input.Config.Model))
	if err != nil {
		return input, kernel.BadAuthRequest("当前系统渠道模型未配置或已停用")
	}
	profile, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if input.Mode == "image" {
		if err != nil {
			return input, kernel.BadAuthRequest("当前图片模型能力参数无效")
		}
		imageProfile := DefaultImageCapabilityConfig(string(item.Protocol), kernel.FirstNonEmpty(item.ProviderModelKey, item.ModelKey))
		if profile != nil && profile.Image != nil {
			imageProfile = profile.Image
		}
		return input, validateImageTask(applyModelSpecificImageCapability(imageProfile, string(item.Protocol), kernel.FirstNonEmpty(item.ProviderModelKey, item.ModelKey), input.Config.APIFormat), input)
	}
	if err != nil || profile == nil || profile.Video == nil {
		return input, kernel.BadAuthRequest("当前视频模型尚未配置能力参数")
	}
	normalized, normalizeErr := NormalizeModelCapabilityConfigForModel("video", string(item.Protocol), kernel.FirstNonEmpty(item.ProviderModelKey, item.ModelKey), profile)
	if normalizeErr != nil || normalized == nil || normalized.Video == nil {
		return input, kernel.BadAuthRequest("当前视频模型能力参数无效")
	}
	applyFixedVideoResolution(&input, normalized.Video)
	return input, validateVideoTask(normalized.Video, input)
}

func ValidateWorkflowProviderPromptLength(input TaskInput) error {
	profile := input.Config.CapabilityConfig
	if input.Mode != "video" || profile == nil || profile.Video == nil {
		return nil
	}
	return validateVideoPromptLength(input.Prompt, profile.Video.References)
}
