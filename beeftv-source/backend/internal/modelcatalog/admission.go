package modelcatalog

import (
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

// TaskSelectRequest is the typed admission input. App supplies the live
// frontend-models flag; this package owns routing, system-channel rebuild,
// variant rewrite, and spec defaults.
type TaskSelectRequest struct {
	Input           map[string]any
	LogicalModelID  string
	Type            string
	Operation       string
	FrontendEnabled bool
}

// TaskSelectLookup is the persistence/router port. Callers pass repo and the
// already-owned logical-model resolver; they must not inject Service methods
// that still contain admission policy.
type TaskSelectLookup struct {
	SystemChannel     func(id string) (*model.ModelChannel, error)
	ChannelModelByKey func(channelID, modelKey string) (*model.ChannelModel, error)
	ResolveLogical    func(logicalModelID string, intent ModelRequestIntent) (*RoutedModel, error)
}

// TaskSelectResult is the admitted input plus an optional frontend route binding.
type TaskSelectResult struct {
	Input  map[string]any
	Routed *RoutedModel
}

// SelectTaskModel is the production admission algorithm for ordinary generation.
// Workflow-plugin authorization stays a cross-domain bridge in the caller.
func SelectTaskModel(req TaskSelectRequest, lookup TaskSelectLookup) (TaskSelectResult, error) {
	input := req.Input
	customChannelTask := TaskInputUsesCustomChannel(input)
	if req.FrontendEnabled && !TaskInputUsesSystemChannel(input) && !customChannelTask {
		if strings.TrimSpace(req.LogicalModelID) == "" {
			return TaskSelectResult{}, InvalidModelSelection("前台模型模式下必须指定 logicalModelId")
		}
		if lookup.ResolveLogical == nil {
			return TaskSelectResult{}, InvalidModelSelection("前台模型模式下必须指定 logicalModelId")
		}
		intent := ModelRequestIntentFromTaskInput(input, req.Type, req.Operation)
		routed, err := lookup.ResolveLogical(req.LogicalModelID, intent)
		if err != nil {
			return TaskSelectResult{}, err
		}
		return TaskSelectResult{Input: ApplyRoutedProviderSelection(input, routed), Routed: routed}, nil
	}

	if strings.TrimSpace(req.LogicalModelID) != "" {
		return TaskSelectResult{}, ModelCatalogMismatch("模型目录已更新，请重新选择")
	}
	if !customChannelTask {
		resolved, err := ResolveSystemChannelModelSelection(input, req.Type, req.Operation, lookup)
		if err != nil {
			return TaskSelectResult{}, err
		}
		return TaskSelectResult{Input: resolved}, nil
	}
	return TaskSelectResult{Input: input}, nil
}

// ResolveSystemChannelModelSelection rebuilds protocol, capability, execution
// spec, and upstream model identity from the server record. Client workflow
// interfaceType, variantId, and providerModelKey cannot drive execution.
func ResolveSystemChannelModelSelection(input map[string]any, taskType string, operation string, lookup TaskSelectLookup) (map[string]any, error) {
	config, ok := input["config"].(map[string]any)
	if !ok {
		return input, InvalidModelSelection("缺少模型配置")
	}

	channelID := strings.TrimSpace(admissionString(config["channelId"]))
	modelKey := strings.TrimPrefix(strings.TrimSpace(admissionString(config["model"])), "models/")

	if channelID == "" || modelKey == "" {
		return input, InvalidModelSelection("必须指定系统渠道和模型")
	}
	if lookup.SystemChannel == nil || lookup.ChannelModelByKey == nil {
		return input, InvalidModelSelection("指定的渠道不存在")
	}

	channel, err := lookup.SystemChannel(channelID)
	if err != nil {
		return input, InvalidModelSelection("指定的渠道不存在")
	}
	if !channel.Enabled || channel.Scope != model.ChannelScopeSystem {
		return input, InvalidModelSelection("指定的渠道不可用")
	}

	channelModel, err := lookup.ChannelModelByKey(channelID, modelKey)
	if err != nil {
		return input, InvalidModelSelection("指定的模型不存在")
	}
	if !channelModel.Enabled {
		return input, InvalidModelSelection("指定的模型已停用")
	}
	if channelModel.Protocol == "" {
		return input, InvalidModelSelection("指定的模型未配置请求协议")
	}

	nextConfig := make(map[string]any, len(config)+6)
	for key, value := range config {
		switch key {
		case "channelId", "channelModelKey", "variantId", "providerModelKey", "apiFormat", "interfaceType", "baseUrl", "apiKey", "secretKey", "headers", "model", "capabilityConfig":
			continue
		default:
			nextConfig[key] = value
		}
	}
	if options, ok := input["capabilityOptions"].(map[string]any); ok {
		for key, value := range options {
			canonical := canonicalCapabilityOptionName(key)
			if isCapabilityOptionFor(channelModel.Capability, canonical) {
				nextConfig[canonical] = providerConfigOptionValue(value)
			}
		}
	}

	capabilityConfig, err := normalizedChannelModelCapability(channelModel)
	if err != nil {
		return input, InvalidModelSelection("指定的模型能力配置无效，请联系管理员")
	}
	var capabilitySpec *CapabilitySpec
	if normalizeCapability(channelModel.Capability) != "audio" {
		spec, specErr := CapabilitySpecFromModelCapabilityConfig(capabilityConfig, channelModel.Capability)
		if specErr != nil {
			return input, InvalidModelSelection("指定的模型能力配置无效，请联系管理员")
		}
		capabilitySpec = &spec
	}
	ApplyChannelCapabilityDefaults(nextConfig, channelModel.Capability, capabilityConfig)
	input["config"] = nextConfig
	var declaredOptions map[string]OptionConstraint
	if capabilitySpec != nil {
		declaredOptions = capabilitySpec.Options
	}
	input["capabilityOptions"] = CapabilityOptionsFromConfig(channelModel.Capability, nextConfig, declaredOptions)

	intent := ModelRequestIntentFromTaskInput(input, taskType, operation)
	if normalizeCapability(intent.Capability) != normalizeCapability(channelModel.Capability) {
		return input, ModelCapabilityNotSupported("所选模型与任务能力不匹配")
	}
	if normalizeCapability(channelModel.Capability) != "audio" {
		if capabilitySpec == nil {
			return input, InvalidModelSelection("指定的模型能力配置无效，请联系管理员")
		}
		if match := MatchCapability(*capabilitySpec, intent); !match.Matched {
			return input, ModelCapabilityNotSupported("所选模型不支持当前请求：" + strings.Join(match.Reasons, "；"))
		}
	}

	variantIntent := intent
	if normalizeCapability(channelModel.Capability) == "image" {
		variantOptions := make(map[string]any, len(intent.Options)+2)
		for k, v := range intent.Options {
			variantOptions[k] = v
		}
		rawQuality := strings.ToLower(strings.TrimSpace(fmt.Sprint(nextConfig["quality"])))
		if rawQuality != "" && rawQuality != "<nil>" && rawQuality != "auto" && rawQuality != "any" {
			variantOptions["quality"] = rawQuality
		} else if variantOptions["quality"] == nil || variantOptions["quality"] == "" || variantOptions["quality"] == "auto" {
			variantOptions["quality"] = "1k"
		}
		if rawSize := strings.ToLower(strings.TrimSpace(fmt.Sprint(nextConfig["size"]))); rawSize != "" && rawSize != "<nil>" && rawSize != "auto" {
			variantOptions["size"] = rawSize
		}
		variantIntent.Options = variantOptions
	}

	variant := channelModelVariantForIntent(*channelModel, variantIntent)
	if variant == nil {
		variant = channelModelVariantForIntent(*channelModel, intent)
	}
	if len(channelModel.Variants) > 0 && variant == nil {
		return input, ModelCapabilityNotSupported("指定的模型不支持当前规格")
	}

	nextConfig["channelId"] = channel.ID
	nextConfig["model"] = channelModel.ModelKey
	nextConfig["channelModelKey"] = channelModel.ModelKey
	if variant != nil {
		nextConfig["variantId"] = variant.ID
		nextConfig["providerModelKey"] = kernel.FirstNonEmpty(variant.ProviderModelKey, channelModel.ProviderModelKey, channelModel.ModelKey)
	} else {
		delete(nextConfig, "variantId")
		nextConfig["providerModelKey"] = kernel.FirstNonEmpty(channelModel.ProviderModelKey, channelModel.ModelKey)
	}
	nextConfig["interfaceType"] = string(channelModel.Protocol)
	nextConfig["apiFormat"] = ChannelAPIFormatForProtocol(channel.APIFormat, channelModel.Protocol)
	return input, nil
}

// ApplyChannelCapabilityDefaults only fills parameters the client left blank,
// using administrator-saved defaults. Values are later copied into
// capabilityOptions so match, SKU, and provider execution see one spec.
func ApplyChannelCapabilityDefaults(config map[string]any, capability string, profile *ModelCapabilityConfig) {
	setDefault := func(key string, value any) {
		if existing, exists := config[key]; !exists || existing == nil || strings.TrimSpace(fmt.Sprint(existing)) == "" {
			config[key] = fmt.Sprint(value)
		}
	}
	switch normalizeCapability(capability) {
	case "image":
		if profile == nil || profile.Image == nil {
			return
		}
		if profile.Image.Size.Parameter != "none" {
			setDefault("size", profile.Image.Size.Default)
		}
		if profile.Image.Quality.Supported {
			setDefault("quality", profile.Image.Quality.Default)
			if value := strings.ToLower(strings.TrimSpace(fmt.Sprint(config["quality"]))); (value == "auto" || value == "any") && !containsCapabilityString(profile.Image.Quality.Values, "auto") {
				config["quality"] = profile.Image.Quality.Default
			}
		}
		setDefault("transparentBackground", profile.Image.TransparentBackground.Default)
		setDefault("count", 1)
	case "video":
		if profile == nil || profile.Video == nil {
			return
		}
		if videoDurationSupported(profile.Video) {
			setDefault("videoSeconds", profile.Video.Duration.Default)
		}
		setDefault("size", profile.Video.DefaultRatio)
		setDefault("vquality", profile.Video.DefaultResolution)
		setDefault("videoGenerateAudio", profile.Video.GenerateAudio.Default)
		setDefault("videoWatermark", profile.Video.Watermark.Default)
	}
}

func CapabilityOptionsFromConfig(capability string, config map[string]any, declared map[string]OptionConstraint) map[string]any {
	options := map[string]any{}
	for key, value := range config {
		canonical := canonicalCapabilityOptionName(key)
		if !isCapabilityOptionFor(capability, canonical) || value == nil || strings.TrimSpace(fmt.Sprint(value)) == "" {
			continue
		}
		if declared != nil {
			if _, ok := declared[canonical]; !ok {
				continue
			}
		}
		options[canonical] = value
	}
	return options
}

func TaskInputUsesCustomChannel(input map[string]any) bool {
	if TaskInputUsesWorkflowProvider(input) {
		return false
	}
	config, ok := input["config"].(map[string]any)
	if !ok {
		return false
	}
	channelID, _ := config["channelId"].(string)
	baseURL, _ := config["baseUrl"].(string)
	apiKey, _ := config["apiKey"].(string)
	credentialRef, _ := config["credentialRef"].(string)
	if strings.EqualFold(strings.TrimSpace(credentialRef), beefapi.CredentialRef) || strings.TrimSpace(channelID) == beefapi.ChannelID {
		return strings.TrimSpace(baseURL) != "" && strings.TrimSpace(apiKey) != ""
	}
	if strings.TrimSpace(channelID) != "" || SystemChannelIDFromBaseURL(baseURL) != "" {
		return false
	}
	return strings.TrimSpace(baseURL) != "" && strings.TrimSpace(apiKey) != ""
}

func TaskInputUsesSystemChannel(input map[string]any) bool {
	config, ok := input["config"].(map[string]any)
	if !ok {
		return false
	}
	channelID, _ := config["channelId"].(string)
	return strings.TrimSpace(channelID) != ""
}

func TaskInputUsesWorkflowProvider(input map[string]any) bool {
	config, ok := input["config"].(map[string]any)
	if !ok {
		return false
	}
	// 系统渠道的 interfaceType 是客户端缓存，不是授权事实；必须先走系统模型 admission。
	if strings.TrimSpace(admissionString(config["channelId"])) != "" {
		return false
	}
	return IsWorkflowInterfaceType(admissionString(config["interfaceType"]))
}

func IsWorkflowInterfaceType(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case string(model.ChannelInterfaceRunningHubImage), string(model.ChannelInterfaceRunningHubVideo), string(model.ChannelInterfaceRunningHubAudio):
		return true
	default:
		return false
	}
}

func HasExecutableVideoConfig(input map[string]any) bool {
	mode, _ := input["mode"].(string)
	config, ok := input["config"].(map[string]any)
	if mode != "video" || !ok {
		return false
	}
	interfaceType := admissionString(config["interfaceType"])
	if IsWorkflowInterfaceType(interfaceType) {
		if admissionString(config["workflowId"]) == "" && admissionString(config["webappId"]) == "" && admissionString(config["model"]) == "" {
			return false
		}
		return admissionString(config["baseUrl"]) != "" && admissionString(config["apiKey"]) != ""
	}
	if admissionString(config["model"]) == "" {
		return false
	}
	return admissionString(config["channelId"]) != "" || (admissionString(config["baseUrl"]) != "" && admissionString(config["apiKey"]) != "")
}

// ChannelAPIFormatForProtocol chooses auth/envelope format from the model
// protocol. A system channel may host mixed protocols; the channel-level
// APIFormat is only a fallback when protocol is empty.
func ChannelAPIFormatForProtocol(channelDefault string, protocol model.ChannelInterfaceType) string {
	switch protocol {
	case model.ChannelInterfaceGeminiVeo, model.ChannelInterfaceGeminiImage:
		return "gemini"
	case model.ChannelInterfaceClaudeAPI:
		return "claude"
	case "":
		return strings.TrimSpace(channelDefault)
	default:
		return "openai"
	}
}

func admissionString(value any) string {
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "<nil>" {
		return ""
	}
	return text
}
