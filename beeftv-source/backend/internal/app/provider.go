package app

// 画布生成任务调度、输入水合与跨能力共享类型/辅助函数。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

type providerAnalyticsKey struct{}

type providerAnalyticsContext struct {
	UserID            string
	TaskID            string
	ProjectID         string
	TaskType          string
	TraceID           string
	RequestID         string
	Capability        string
	Operation         string
	ChannelID         string
	Model             string
	VideoSeconds      int
	RequestKind       string
	ProviderRequestID string
	ConcurrencyLimit  int
}

func withProviderAnalytics(ctx context.Context, service *Service, task model.Task) context.Context {
	metadata := providerAnalyticsContext{UserID: task.UserID, TaskID: task.ID, ProjectID: task.ProjectID, TaskType: task.Type, TraceID: task.TraceID, RequestID: task.RequestID, Capability: capabilityFromTaskType(task.Type), Operation: task.Operation, Model: task.Model, ProviderRequestID: task.ProviderRequestID}
	var input struct {
		Mode   string         `json:"mode"`
		Config providerConfig `json:"config"`
	}
	if json.Unmarshal([]byte(task.InputJSON), &input) == nil {
		metadata.ChannelID = firstNonEmpty(input.Config.ChannelID, systemChannelIDFromBaseURL(input.Config.BaseURL))
		metadata.Model = firstNonEmpty(input.Config.ChannelModelKey, input.Config.Model, metadata.Model)
		metadata.VideoSeconds, _ = strconv.Atoi(input.Config.VideoSeconds)
		if normalized := normalizeCapability(input.Mode); normalized != "" {
			metadata.Capability = normalized
		}
	}
	ctx = context.WithValue(ctx, providerAnalyticsKey{}, metadata)
	return service.bindGenerationRuntime(ctx, generationCallMeta(metadata))
}

func resumedProviderRequestID(ctx context.Context) string {
	if id := generation.ResumedProviderRequestID(ctx); id != "" {
		return id
	}
	metadata, _ := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	return strings.TrimSpace(metadata.ProviderRequestID)
}

func withProviderRequestKind(ctx context.Context, requestKind string) context.Context {
	metadata, ok := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if !ok {
		return generation.WithRequestKind(ctx, requestKind)
	}
	metadata.RequestKind = requestKind
	ctx = context.WithValue(ctx, providerAnalyticsKey{}, metadata)
	return generation.WithRequestKind(ctx, requestKind)
}

func canonicalCallMeta(ctx context.Context) generation.CallMeta {
	if runtime, ok := generation.RuntimeFromContext(ctx); ok {
		if strings.TrimSpace(runtime.Call.UserID) != "" || strings.TrimSpace(runtime.Call.TaskID) != "" || strings.TrimSpace(runtime.Call.RequestKind) != "" || runtime.Call.ConcurrencyLimit != 0 {
			return runtime.Call
		}
	}
	metadata, _ := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	return generationCallMeta(metadata)
}

func newProviderPayloadError(raw string) providerPayloadError {
	return generation.NewPayloadError(raw, providerPayloadErrorMessage(raw))
}

func providerUserFacingErrorMessage(err error) string {
	if err == nil {
		return generation.ClassifyError(nil).UserMessage()
	}
	return classifyTaskFailure(err).UserMessage()
}

// providerPayloadErrorCategory 把上游失败正文交给 generation 归类。
// 第二个返回值为 false 表示正文没有稳定类目，调用方应退回 HTTP 兜底，不要回传原文。
func providerPayloadErrorCategory(raw string) (string, bool) {
	failure := generation.ClassifyText(raw)
	if failure.Category == generation.CategoryUnknown {
		return "", false
	}
	return failure.UserMessage(), true
}

func providerPayloadErrorMessage(raw string) string {
	return generation.ClassifyText(raw).UserMessage()
}

func (s *Service) processCanvasGenerationTask(ctx context.Context, userID string, taskProjectID string, taskType string, fallbackPrompt string, rawInput string) (map[string]interface{}, error) {
	ctx = withProtocolRegistry(ctx, s.protocolRegistry())
	var input canvasGenerationInput
	defer func() { recordTaskDiagnosticInput(ctx, input) }()
	if err := json.Unmarshal([]byte(rawInput), &input); err != nil {
		return nil, fmt.Errorf("任务输入解析失败：%w", err)
	}
	ctx = s.enrichGenerationRuntime(ctx, generation.CallMeta{UserID: userID, TaskID: taskExecutionID(ctx), ProjectID: taskProjectID, TaskType: taskType})
	if strings.TrimSpace(input.Prompt) == "" {
		input.Prompt = fallbackPrompt
	}
	if input.Mode == "" && strings.HasPrefix(taskType, "video_") {
		input.Mode = "video"
	}
	if input.Mode == "text" && strings.HasPrefix(taskType, "canvas_text") && input.AgentRequests == nil {
		textPublisher := newTaskTextStreamPublisher(s, userID, taskExecutionID(ctx))
		input.OnTextDelta = textPublisher.Publish
		defer textPublisher.Close()
	}
	return generation.Execute(ctx, input)
}

func providerMediaHydrationPolicyFor(ctx context.Context, input canvasGenerationInput) providerMediaHydrationPolicy {
	return generation.MediaHydrationPolicyFor(ctx, input)
}

func providerPrefersMediaURLs(interfaceType string, input canvasGenerationInput) bool {
	return generation.PrefersMediaURLs(interfaceType, input)
}

type styleExecutionPlanDocument struct {
	SchemaVersion   int    `json:"schemaVersion"`
	ProfilePresetID string `json:"profilePresetId"`
	ProfileRevision int    `json:"profileRevision"`
	Mode            string `json:"mode"`
	Model           string `json:"model"`
	InterfaceType   string `json:"interfaceType"`
	Status          string `json:"status"`
	Prompt          string `json:"prompt"`
}

func (s *Service) applyGenerationStyleProfile(userID string, taskProjectID string, input *canvasGenerationInput) error {
	styleProfileJSON := metadataString(input.Metadata, "styleProfileJson")
	if strings.TrimSpace(styleProfileJSON) == "" {
		return nil
	}
	if _, err := validateStyleProfileJSON(styleProfileJSON); err != nil {
		return fmt.Errorf("项目画风执行配置无效：%w", err)
	}
	var profile styleProfileDocument
	if err := json.Unmarshal([]byte(styleProfileJSON), &profile); err != nil {
		return fmt.Errorf("项目画风执行配置解析失败：%w", err)
	}
	storedProfileJSON, storedPresetID, belongsToProject, err := s.taskProjectStyleProfile(userID, taskProjectID)
	if err != nil {
		return fmt.Errorf("读取项目画风失败：%w", err)
	}
	if belongsToProject {
		if strings.TrimSpace(storedProfileJSON) == "" {
			// 旧项目只有 preset ID，允许画布把该预设编译为结构化快照；仍需锁定同一预设，不能借降级路径换画风。
			if strings.TrimSpace(storedPresetID) == "" || strings.TrimSpace(profile.PresetID) != strings.TrimSpace(storedPresetID) {
				return errors.New("项目画风已发生变化，请返回项目列表后重新打开当前项目再生成")
			}
		} else {
			matches, compareErr := equivalentStyleProfileJSON(styleProfileJSON, storedProfileJSON)
			if compareErr != nil {
				return errors.New("项目画风配置暂时无法读取，请在项目设置中重新保存画风后重试")
			}
			if !matches {
				// 项目画风可能在另一个页面更新；保存路径以服务端快照为准，生成时自动采用最新版本。
				validatedStoredProfileJSON, validateErr := validateStyleProfileJSON(storedProfileJSON)
				if validateErr != nil || json.Unmarshal([]byte(validatedStoredProfileJSON), &profile) != nil {
					return errors.New("项目画风配置暂时无法读取，请在项目设置中重新保存画风后重试")
				}
			}
		}
	}
	// 执行计划是前端为即时预览生成的派生数据。平台模型入队后可能改选真实供应线路，
	// 因此后端必须以最终模型重新编译，不能要求用户手动“刷新配置”来同步内部路由。
	plan, _ := decodeStyleExecutionPlan(input.Metadata["styleExecutionPlan"])
	stylePrompt, expectedStatus, warnings := resolveGenerationStyleExecution(profile, input.Config.Model, firstNonEmpty(input.Config.InterfaceType, input.Config.APIFormat))
	input.Prompt = reconcileGenerationStylePrompt(input.Prompt, plan.Prompt, stylePrompt)
	if expectedStatus == "blocked" {
		return fmt.Errorf("当前图片模型无法完整执行项目画风：%s。请切换图片模型，或在项目设置中停用对应画风资产", strings.Join(warnings, "；"))
	}
	return nil
}

func reconcileGenerationStylePrompt(prompt string, previousStylePrompt string, currentStylePrompt string) string {
	content := strings.TrimSpace(prompt)
	previous := strings.TrimSpace(previousStylePrompt)
	if previous != "" {
		previousBlock := "【项目画风执行规范】\n" + previous
		if strings.HasSuffix(content, previousBlock) {
			content = strings.TrimSpace(strings.TrimSuffix(content, previousBlock))
		}
	}
	current := strings.TrimSpace(currentStylePrompt)
	if current == "" || strings.HasSuffix(content, "【项目画风执行规范】\n"+current) {
		return content
	}
	return strings.TrimSpace(content + "\n\n【项目画风执行规范】\n" + current)
}

func (s *Service) taskProjectStyleProfile(userID string, canvasOrProjectID string) (string, string, bool, error) {
	id := strings.TrimSpace(canvasOrProjectID)
	if id == "" {
		return "", "", false, nil
	}
	if canvas, err := s.repo.CanvasProjectForUser(userID, id); err == nil {
		if strings.TrimSpace(canvas.ProjectID) == "" {
			return "", "", false, nil
		}
		project, projectErr := s.repo.ProjectForUser(userID, canvas.ProjectID)
		if projectErr != nil {
			return "", "", true, projectErr
		}
		return project.StyleProfileJSON, project.StylePresetID, true, nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return "", "", false, err
	}
	project, err := s.repo.ProjectForUser(userID, id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", "", false, nil
		}
		return "", "", false, err
	}
	return project.StyleProfileJSON, project.StylePresetID, true, nil
}

func equivalentStyleProfileJSON(left string, right string) (bool, error) {
	var leftValue interface{}
	if err := json.Unmarshal([]byte(left), &leftValue); err != nil {
		return false, err
	}
	var rightValue interface{}
	if err := json.Unmarshal([]byte(right), &rightValue); err != nil {
		return false, err
	}
	leftCanonical, err := json.Marshal(leftValue)
	if err != nil {
		return false, err
	}
	rightCanonical, err := json.Marshal(rightValue)
	if err != nil {
		return false, err
	}
	return bytes.Equal(leftCanonical, rightCanonical), nil
}

func decodeStyleExecutionPlan(value interface{}) (styleExecutionPlanDocument, error) {
	if value == nil {
		return styleExecutionPlanDocument{}, errors.New("项目画风执行计划缺失")
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return styleExecutionPlanDocument{}, errors.New("项目画风执行计划格式无效")
	}
	var plan styleExecutionPlanDocument
	if err := json.Unmarshal(raw, &plan); err != nil {
		return styleExecutionPlanDocument{}, errors.New("项目画风执行计划格式无效")
	}
	return plan, nil
}

func resolveGenerationStyleExecution(profile styleProfileDocument, generationModel string, interfaceType string) (string, string, []string) {
	fragments := []string{strings.TrimSpace(profile.Prompt)}
	if negative := strings.TrimSpace(profile.NegativePrompt); negative != "" {
		fragments = append(fragments, "【全局负面 Prompt】\n"+negative)
	}
	warnings := make([]string, 0)
	for _, asset := range profile.Assets {
		if asset.Enabled != nil && !*asset.Enabled {
			continue
		}
		if asset.Status != "validated" {
			reason := "资产尚未验证"
			if asset.Status == "unavailable" {
				reason = "资产当前不可用"
			}
			warnings = append(warnings, asset.Title+"："+reason)
			continue
		}
		if len(asset.BaseModels) > 0 && !styleAssetSupportsModel(asset.BaseModels, generationModel) {
			warnings = append(warnings, asset.Title+"：仅兼容 "+strings.Join(asset.BaseModels, "、"))
			continue
		}
		switch asset.Kind {
		case "prompt", "template":
			fragments = append(fragments, strings.TrimSpace(asset.PromptFragment))
			fragments = append(fragments, nonEmptyStyleProfileStrings(asset.TriggerWords)...)
		case "reference":
			warnings = append(warnings, asset.Title+"：项目参考图自动注入适配器尚未启用")
		case "lora":
			warnings = append(warnings, asset.Title+"：当前 "+firstNonEmpty(interfaceType, "图片")+" 协议未启用 LoRA 适配器")
		}
	}
	normalizedFragments := nonEmptyStyleProfileStrings(fragments)
	status := "ready"
	if len(warnings) > 0 {
		status = "degraded"
		if profile.ExecutionPolicy == "strict-assets" {
			status = "blocked"
		}
	}
	return strings.Join(normalizedFragments, "\n"), status, warnings
}

func styleAssetSupportsModel(baseModels []string, generationModel string) bool {
	for _, baseModel := range baseModels {
		if strings.EqualFold(strings.TrimSpace(baseModel), strings.TrimSpace(generationModel)) {
			return true
		}
	}
	return false
}

func (s *Service) validateResolvedImageCapability(input *canvasGenerationInput) error {
	fallback := DefaultImageCapabilityConfig(input.Config.InterfaceType, input.Config.Model)
	channelID := strings.TrimSpace(input.Config.ChannelID)
	if channelID == "" {
		if input.Config.CapabilityConfig != nil && input.Config.CapabilityConfig.Image != nil {
			input.ImageCapability = input.Config.CapabilityConfig.Image
		} else {
			input.ImageCapability = fallback
		}
		return validateImageTask(input.ImageCapability, *input)
	}
	item, err := s.repo.ChannelModelByKey(channelID, providerChannelModelKey(input.Config))
	if err != nil {
		return errors.New("当前系统渠道模型未配置或已停用")
	}
	profile, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if err != nil {
		return errors.New("当前图片模型能力参数无效")
	}
	if profile != nil && profile.Image != nil {
		input.ImageCapability = profile.Image
	} else {
		input.ImageCapability = fallback
	}
	return validateImageTask(input.ImageCapability, *input)
}

func metadataStringValues(value any) map[string]string {
	values := map[string]string{}
	raw, ok := value.(map[string]interface{})
	if !ok {
		return values
	}
	for key, item := range raw {
		values[key] = strings.TrimSpace(fmt.Sprint(item))
	}
	return values
}

// Read owned resource metadata before preflight, without downloading media.
// Character/workflow references may carry only a resource storage key.
func (s *Service) hydrateVideoReferenceMetadata(ctx context.Context, userID string, input *canvasGenerationInput) error {
	ctx = s.enrichGenerationRuntime(ctx, generation.CallMeta{UserID: userID})
	return generation.HydrateVideoReferenceMetadata(ctx, userID, input)
}

func applySeedance2VideoProbe(config providerConfig, index int, media *providerMedia, data []byte) error {
	w, h, durationMs := probeGeneratedVideoMedia(data)
	if w <= 0 || h <= 0 {
		return BadAuthRequest(fmt.Sprintf("第 %d 个参考视频尺寸无法读取，请重新导出 MP4/MOV 后导入", index+1))
	}
	media.Width, media.Height = w, h
	_, fps := referenceVideoEncoding(data)
	if err := referenceVideoFrameRateError(config, index, fps); err != nil {
		return err
	}
	if durationMs > 0 {
		media.DurationMs = durationMs
	}
	return nil
}

func (s *Service) hydrateGenerationMedia(userID string, input *canvasGenerationInput, policy providerMediaHydrationPolicy) error {
	return s.hydrateGenerationMediaWithContext(context.Background(), userID, input, policy)
}

func (s *Service) hydrateGenerationMediaWithContext(ctx context.Context, userID string, input *canvasGenerationInput, policy providerMediaHydrationPolicy) error {
	ctx = s.enrichGenerationRuntime(ctx, generation.CallMeta{UserID: userID})
	return generation.HydrateMedia(ctx, userID, input, policy)
}

func (s *Service) hydrateProviderMedia(userID string, media *providerMedia, policy providerMediaHydrationPolicy) error {
	ctx := s.enrichGenerationRuntime(context.Background(), generation.CallMeta{UserID: userID})
	return generation.HydrateOne(ctx, userID, media, policy)
}

func resourceLooksLikeImage(resource *model.Resource, media *providerMedia) bool {
	if resource != nil && (strings.EqualFold(resource.Kind, "image") || strings.HasPrefix(strings.ToLower(resource.MimeType), "image/")) {
		return true
	}
	if media == nil {
		return false
	}
	return strings.HasPrefix(strings.ToLower(firstNonEmpty(media.MimeType, media.Type)), "image/")
}

func resourceUsesObjectStorage(resource *model.Resource) bool {
	if resource == nil {
		return false
	}
	provider := strings.ToLower(strings.TrimSpace(resource.Provider))
	return provider != "" && provider != "local"
}

func normalizedMediaMimeType(declared string, data []byte) string {
	return generation.NormalizedMediaMIMEType(declared, data)
}

func (s *Service) resolveProviderConfig(config providerConfig) (providerConfig, error) {
	headers, err := NormalizeOutboundHeaders(config.Headers)
	if err != nil {
		return providerConfig{}, err
	}
	config.Headers = headers
	if s.IsLocalMode() && strings.TrimSpace(config.ChannelID) != "" {
		// A stale hosted model selection must not reopen the system-channel
		// catalog in a local workspace. Local users configure the provider
		// endpoint directly; hosted channel IDs are intentionally unsupported.
		return providerConfig{}, errors.New("本地工作区不支持系统渠道配置")
	}
	if isRunningHubInterface(config.InterfaceType) && strings.TrimSpace(config.BaseURL) == "" {
		config.BaseURL = "https://www.runninghub.cn"
	}
	channelID := strings.TrimSpace(config.ChannelID)
	if channelID == "" {
		channelID = systemChannelIDFromBaseURL(config.BaseURL)
	}
	if channelID == "" {
		if _, err := ValidateOutboundURL(config.BaseURL); err != nil {
			return providerConfig{}, err
		}
		return config, nil
	}
	channel, err := s.SystemChannel(channelID)
	if err != nil {
		return providerConfig{}, errors.New("系统渠道不存在或已停用")
	}
	modelKey := strings.TrimPrefix(strings.TrimSpace(config.ChannelModelKey), "models/")
	requestedModel := strings.TrimPrefix(strings.TrimSpace(config.Model), "models/")
	if modelKey == "" {
		modelKey = requestedModel
	}
	if modelKey == "" {
		channelModels, listErr := s.repo.ChannelModels(channel.ID, false)
		if listErr != nil {
			return providerConfig{}, listErr
		}
		if len(channelModels) > 0 {
			modelKey = channelModels[0].ModelKey
		} else {
			models := channelModelNames(*channel)
			if len(models) == 0 {
				return providerConfig{}, errors.New("系统渠道未配置可用模型")
			}
			modelKey = models[0]
		}
	}
	if _, err := ValidateOutboundURL(channel.BaseURL); err != nil {
		return providerConfig{}, err
	}
	config.ChannelID = channel.ID
	config.APIFormat = channel.APIFormat
	channelModel, modelErr := s.repo.ChannelModelByKey(channel.ID, modelKey)
	if modelErr != nil {
		// ModelsJSON 只是旧渠道表上的目录缓存。SKU 合并后它不能代表可执行模型，
		// 唯一授权来源必须是已启用的 channel_models 记录。
		return providerConfig{}, errors.New("当前系统渠道未授权该模型")
	}
	if channelModel.Protocol == "" {
		return providerConfig{}, errors.New("当前模型尚未配置请求协议")
	}
	providerModelKey := strings.TrimPrefix(strings.TrimSpace(config.ProviderModelKey), "models/")
	authorizedUpstream := strings.TrimPrefix(strings.TrimSpace(channelModel.ProviderModelKey), "models/")
	if config.VariantID != "" {
		matched := false
		for _, tier := range channelModel.Variants {
			if tier.ID == config.VariantID && tier.Enabled {
				providerModelKey = firstNonEmpty(providerModelKey, tier.ProviderModelKey)
				matched = true
				break
			}
		}
		if !matched {
			return providerConfig{}, errors.New("当前模型规格已更新，请重新创建任务")
		}
	} else if !trustedSystemModelIdentity(modelKey, requestedModel, providerModelKey, authorizedUpstream) {
		return providerConfig{}, errors.New("系统渠道模型标识不一致")
	}
	config.InterfaceType = string(channelModel.Protocol)
	config.APIFormat = channelAPIFormatForProtocol(channel.APIFormat, channelModel.Protocol)
	config.BaseURL = channel.BaseURL
	config.APIKey = channel.APIKey
	config.SecretKey = channel.SecretKey
	config.Headers, err = ParseOutboundHeadersJSON(channel.HeadersJSON)
	if err != nil {
		return providerConfig{}, err
	}
	config.ChannelModelKey = modelKey
	config.ProviderModelKey = providerModelKey
	config.Model = firstNonEmpty(providerModelKey, channelModel.ProviderModelKey, modelKey)
	return config, nil
}

// channelAPIFormatForProtocol 以模型协议而不是客户端缓存决定鉴权和请求封装格式。
// 同一系统渠道可以挂载不同协议的模型，因此渠道级 APIFormat 只能作为协议缺失时的兼容值。
func channelAPIFormatForProtocol(channelDefault string, protocol model.ChannelInterfaceType) string {
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

func providerChannelModelKey(config providerConfig) string {
	return strings.TrimPrefix(strings.TrimSpace(firstNonEmpty(config.ChannelModelKey, config.Model)), "models/")
}

// trustedSystemModelIdentity 接受目录 SKU、授权上游标识，或已经解析过的配对。
// 其它客户端自报的模型键一律拒绝。
func trustedSystemModelIdentity(sku, requestedModel, requestedProviderKey, authorizedUpstream string) bool {
	return allowedSystemModelKey(requestedModel, sku, authorizedUpstream) && allowedSystemModelKey(requestedProviderKey, sku, authorizedUpstream)
}

func allowedSystemModelKey(value, sku, authorizedUpstream string) bool {
	value = strings.TrimSpace(value)
	return value == "" || value == sku || (authorizedUpstream != "" && value == authorizedUpstream)
}

func systemChannelIDFromBaseURL(baseURL string) string {
	value := strings.TrimSpace(baseURL)
	lowerValue := strings.ToLower(value)
	for _, marker := range []string{"/api/ai/system/", "/api/"} {
		index := strings.LastIndex(lowerValue, marker)
		if index < 0 {
			continue
		}
		id := strings.Trim(value[index+len(marker):], "/")
		if queryIndex := strings.IndexAny(id, "?#"); queryIndex >= 0 {
			id = id[:queryIndex]
		}
		if slash := strings.Index(id, "/"); slash >= 0 {
			continue
		}
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		switch strings.ToLower(id) {
		case "v1", "v1beta", "v2", "v3", "plan", "ai":
			continue
		default:
			return id
		}
	}
	return ""
}

func openAIImageInputURL(media providerMedia) (string, error) {
	return generation.OpenAIImageInputURL(media)
}

func openAIVideoInputURL(media providerMedia) (string, error) {
	return generation.OpenAIVideoInputURL(media)
}

func firstNonEmptyString(values ...string) string {
	return kernel.FirstNonEmpty(values...)
}

func dataURL(mimeType string, data []byte) string {
	return generation.DataURL(mimeType, data)
}

// stringField 只读取异构上游 JSON 中的可选字符串：缺失或 null 返回空串，存在但类型错误也不强制转换。
// task ID 等必填标识必须使用 firstJSONString，让类型错误显式失败。
func stringField(payload map[string]interface{}, key string) string {
	value, err := optionalJSONString(payload, key)
	if err != nil {
		return ""
	}
	return value
}

func withSystemPrompt(config providerConfig, prompt string) string {
	return generation.WithSystemPrompt(config, prompt)
}

func metadataString(metadata map[string]interface{}, key string) string {
	return strings.TrimSpace(stringField(metadata, key))
}
