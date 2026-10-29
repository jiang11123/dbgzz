package generation

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/provider/workflow"
	"infinite-canvas/backend/internal/providerpreset"
)

// Execute owns paid-generation orchestration: prompt templates, config,
// capability, hydration, workflow resume, placeholder resolution, then the
// mode-specific upstream call. Config, secrets and style stay on typed ports.
func Execute(ctx context.Context, input Input) (map[string]any, error) {
	runtime, _ := RuntimeFromContext(ctx)
	userID := strings.TrimSpace(runtime.Call.UserID)
	if strings.TrimSpace(input.Mode) == "" && strings.HasPrefix(runtime.Call.TaskType, "video_") {
		input.Mode = "video"
	}

	promptTemplateOperation := metadataString(input.Metadata, "promptTemplateOperation")
	if input.Mode != "video" && promptTemplateOperation != "" {
		if runtime.Prompt == nil {
			return nil, errors.New("编译用户提示词失败：提示词端口未接入")
		}
		compiled, err := runtime.Prompt.Compile(userID, promptTemplateOperation, metadataStringValues(input.Metadata["promptTemplateVariables"]))
		if err != nil {
			return nil, fmt.Errorf("编译用户提示词失败：%w", err)
		}
		input.Prompt = compiled
	}
	if strings.TrimSpace(input.Prompt) == "" {
		return nil, errors.New("prompt is required")
	}

	if runtime.Config != nil {
		config, err := runtime.Config.Resolve(input.Config)
		if err != nil {
			return nil, err
		}
		input.Config = config
	} else if strings.TrimSpace(input.Config.ChannelID) != "" {
		return nil, errors.New("无法解析系统渠道配置")
	}
	applyCanvasTextStreaming(runtime.Call.TaskType, &input)
	if UpscaleMediaType(input.Config.Model) != "" {
		if err := requireTaskRuntime(ctx); err != nil {
			return nil, err
		}
		return RunUpscaleTask(ctx, input)
	}
	if input.Mode == "image" && providerpreset.IsBeefAPIEndpoint(input.Config.BaseURL) {
		if contract, ok := providerpreset.BeefAPIImageContract(input.Config.Model); ok {
			input.Config.InterfaceType = contract.Protocol
			input.Config.APIFormat = "openai"
			input.Config.CapabilityConfig = &ModelCapabilityConfig{Version: 1, Image: modelcatalog.DefaultImageCapabilityConfig(contract.Protocol, input.Config.Model)}
		}
	}
	if input.Mode == "video" && providerpreset.IsBeefAPIEndpoint(input.Config.BaseURL) {
		if contract, ok := providerpreset.BeefAPIVideoContract(input.Config.Model); ok {
			input.Config.InterfaceType = contract.Protocol
			input.Config.APIFormat = "openai"
		}
	}

	if workflow.IsProviderInterface(input.Config.InterfaceType) {
		return executeWorkflow(ctx, runtime, userID, input)
	}

	if input.Mode == "image" && input.Metadata != nil && strings.TrimSpace(metadataString(input.Metadata, "styleProfileJson")) != "" {
		if runtime.Style == nil {
			return nil, errors.New("项目画风执行配置无效：画风端口未接入")
		}
		if err := runtime.Style.Apply(userID, runtime.Call.ProjectID, &input); err != nil {
			return nil, err
		}
	}

	if err := validatePreparedInput(ctx, input); err != nil {
		return nil, err
	}
	if err := requireTaskRuntime(ctx); err != nil {
		return nil, err
	}
	runtime, _ = RuntimeFromContext(ctx)

	if input.Mode == "image" && runtime.Config != nil {
		if err := runtime.Config.ApplyCapabilities(ctx, &input); err != nil {
			return nil, err
		}
	}

	resumed := ResumedProviderRequestID(ctx) != ""
	preparing := !resumed && hasReferenceMedia(input)
	if !resumed {
		if err := ValidateMediaTransport(ctx, input); err != nil {
			return nil, err
		}
		if preparing {
			if err := setExecutionStage(ctx, runtime, "正在准备参考素材"); err != nil {
				return nil, err
			}
		}
		if input.Mode == "video" || len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0 {
			if err := HydrateVideoReferenceMetadata(ctx, userID, &input); err != nil {
				return nil, RequestPreparationError{Cause: err}
			}
		}
		if input.Mode == "video" {
			if runtime.Config != nil {
				if err := runtime.Config.ApplyCapabilities(ctx, &input); err != nil {
					return nil, err
				}
			}
		}
		if err := HydrateMedia(ctx, userID, &input, MediaHydrationPolicyFor(ctx, input)); err != nil {
			return nil, err
		}
		if runtime.Config != nil {
			if err := runtime.Config.SyncArkPrivateAssets(ctx, userID, &input); err != nil {
				return nil, err
			}
		}
		if err := PrepareBeefAPIVideoReferences(ctx, input.Config, &input, ownedSeedanceMediaReader(ctx, userID)); err != nil {
			return nil, err
		}
		if err := prepareFullVideoReferences(ctx, &input, ownedFullVideoMediaReader(ctx, userID)); err != nil {
			return nil, err
		}
	}
	if input.Mode == "video" && input.VideoCapability != nil && !resumed {
		if err := validateVideoTask(input.VideoCapability, input); err != nil {
			return nil, err
		}
	}
	if input.Mode == "text" && input.AgentRequests != nil {
		resolved, err := ResolveAgentResourcePlaceholders(input, true)
		if err != nil {
			return nil, err
		}
		input = resolved
	}

	if preparing {
		if runtime.ReferenceProgress != nil {
			runtime.ReferenceProgress.ClearReference()
		}
	}
	if preparing || (input.Mode == "video" && !resumed) {
		if err := setExecutionStage(ctx, runtime, "正在提交生成任务"); err != nil {
			return nil, err
		}
	}
	result, taskErr := dispatch(ctx, input)
	if taskErr == nil && input.Mode == "text" && promptTemplateOperation != "" {
		if runtime.Prompt == nil {
			return nil, errors.New("提示词结果无法校验")
		}
		taskErr = runtime.Prompt.ValidateResult(promptTemplateOperation, result)
	}
	return result, taskErr
}

func dispatch(ctx context.Context, input Input) (map[string]any, error) {
	switch input.Mode {
	case "image":
		return RunImageTask(ctx, input)
	case "text":
		if input.AgentRequests != nil {
			return RunAgentToolTask(ctx, input)
		}
		return RunTextTask(ctx, input)
	case "video":
		return RunVideoTask(ctx, input)
	case "audio":
		return RunAudioTask(ctx, input)
	default:
		return nil, fmt.Errorf("不支持的生成模式：%s", input.Mode)
	}
}

func executeWorkflow(ctx context.Context, runtime Runtime, userID string, input Input) (map[string]any, error) {
	if runtime.Config != nil {
		if err := runtime.Config.RequireWorkflow(input.Config.InterfaceType); err != nil {
			return nil, err
		}
	}
	if err := modelcatalog.ValidateWorkflowProviderPromptLength(taskInputFromCanvas(input)); err != nil {
		return nil, err
	}
	if err := mapWorkflowConfigError(workflow.ValidateConfig(input.Mode, workflowConfig(input.Config))); err != nil {
		return nil, err
	}
	preparing := ResumedProviderRequestID(ctx) == "" && hasReferenceMedia(input)
	if preparing {
		if err := setExecutionStage(ctx, runtime, "正在准备参考素材"); err != nil {
			return nil, err
		}
	}
	if ResumedProviderRequestID(ctx) == "" {
		if err := HydrateMedia(ctx, userID, &input, MediaHydrationPolicy{}); err != nil {
			return nil, err
		}
	}
	if runtime.Workflow == nil {
		return nil, errors.New("无法执行工作流任务，请重试")
	}
	if preparing || (input.Mode == "video" && ResumedProviderRequestID(ctx) == "") {
		if err := setExecutionStage(ctx, runtime, "正在提交生成任务"); err != nil {
			return nil, err
		}
	}
	return runtime.Workflow.Execute(ctx, input)
}

func hasReferenceMedia(input Input) bool {
	return len(input.ReferenceImages)+len(input.ReferenceVideos)+len(input.ReferenceAudios) > 0 || input.Mask != nil
}

func setExecutionStage(ctx context.Context, runtime Runtime, stage string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if runtime.Stages != nil {
		return runtime.Stages.SetStage(ctx, stage)
	}
	return nil
}

func applyCanvasTextStreaming(taskType string, input *Input) {
	if input == nil || input.Mode != "text" || !strings.HasPrefix(strings.TrimSpace(taskType), "canvas_text") {
		return
	}
	requestedStream := input.TextOptions.Stream == nil || *input.TextOptions.Stream
	supportsStream := input.Config.CapabilityConfig == nil || input.Config.CapabilityConfig.Text == nil || input.Config.CapabilityConfig.Text.Streaming == nil || *input.Config.CapabilityConfig.Text.Streaming
	input.StreamText = requestedStream && supportsStream
}

func validatePreparedInput(ctx context.Context, input Input) error {
	if input.Config.APIFormat == "gemini" && input.Config.InterfaceType != string(model.ChannelInterfaceGeminiVeo) && input.Config.InterfaceType != string(model.ChannelInterfaceGeminiImage) {
		_, hasDeclarativeAgent := agentProtocolAdapterForContext(ctx, input.Config.InterfaceType)
		if input.AgentRequests == nil || !hasDeclarativeAgent {
			return errors.New("后端任务队列暂不支持该 Gemini 调用格式，请选择已安装的 Gemini 协议插件")
		}
	}
	if strings.TrimSpace(input.Config.BaseURL) == "" || strings.TrimSpace(input.Config.APIKey) == "" || strings.TrimSpace(input.Config.Model) == "" {
		return errors.New("后端生成任务缺少 Base URL、API Key 或模型名")
	}
	if err := validateInterfaceForContext(ctx, input.Mode, input.Config.InterfaceType); err != nil {
		// This local check precedes the create request. A resumed provider task,
		// however, already has submission evidence that must not be erased.
		if ResumedProviderRequestID(ctx) == "" {
			return ProtocolPreparationError{Cause: err}
		}
		return err
	}
	if IsVolcengineJiMengProtocol(input.Config.InterfaceType) && strings.TrimSpace(input.Config.SecretKey) == "" {
		return errors.New("即梦官方 API 缺少 Secret Key")
	}
	return nil
}

func validateInterfaceForContext(ctx context.Context, mode, interfaceType string) error {
	interfaceType = strings.TrimSpace(interfaceType)
	if interfaceType == "" {
		return nil
	}
	if registry, ok := ProtocolRegistryFromContext(ctx); ok {
		if _, found := registry.Resolve(interfaceType); found {
			return ValidateGenerationInterfaceWithRegistry(registry, mode, interfaceType)
		}
	}
	return ValidateGenerationInterface(mode, interfaceType)
}

func workflowConfig(config Config) workflow.Config {
	return workflow.Config{
		InterfaceType:         config.InterfaceType,
		BaseURL:               config.BaseURL,
		APIKey:                config.APIKey,
		Headers:               config.Headers,
		Model:                 config.Model,
		Size:                  config.Size,
		Quality:               config.Quality,
		TransparentBackground: config.TransparentBackground,
		Count:                 config.Count,
		VideoSeconds:          config.VideoSeconds,
		VQuality:              config.VQuality,
		VideoGenerateAudio:    config.VideoGenerateAudio,
		VideoWatermark:        config.VideoWatermark,
		AudioVoice:            config.AudioVoice,
		AudioFormat:           config.AudioFormat,
		AudioSpeed:            config.AudioSpeed,
		AudioInstructions:     config.AudioInstructions,
		SystemPrompt:          config.SystemPrompt,
		WorkflowID:            config.WorkflowID,
		WebappID:              config.WebappID,
		WorkflowJSON:          config.WorkflowJSON,
		WorkflowFields:        config.WorkflowFields,
		RunningHubUploadKey:   config.RunningHubUploadKey,
	}
}

func mapWorkflowConfigError(err error) error {
	if err == nil {
		return nil
	}
	var req *outbound.BadRequestError
	if errors.As(err, &req) {
		return BadAuthRequest(req.Message)
	}
	return err
}

func requireTaskRuntime(ctx context.Context) error {
	runtime, ok := RuntimeFromContext(ctx)
	if !ok {
		return errors.New("无法执行生成任务，请重试")
	}
	if strings.TrimSpace(runtime.Call.UserID) == "" || strings.TrimSpace(runtime.Call.TaskID) == "" {
		return errors.New("生成任务缺少用户或任务身份")
	}
	if runtime.Images == nil || runtime.Receipts == nil || runtime.Limits == nil {
		return errors.New("无法执行生成任务，请重试")
	}
	return nil
}
