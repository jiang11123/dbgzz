package modelcatalog

import (
	"strings"

	"infinite-canvas/backend/internal/assistant"
	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/protocol"
)

const (
	AssistantReasonModelNotConfigured  = assistant.ReasonModelNotConfigured
	AssistantReasonCredentialMissing   = assistant.ReasonCredentialMissing
	AssistantReasonProtocolUnsupported = assistant.ReasonProtocolUnsupported
)

// assistantProtocols 是助手会话支持的文本协议。配置里历史上同时出现
// "responses" 与 "openai-response" 两种写法，这里都接受并归一。
var assistantProtocols = map[string]string{
	"chat-completion": "chat-completion",
	"claude-api":      "claude-api",
	"responses":       "responses",
	"openai-response": "responses",
}

var managedAssistantModels = []string{beefapi.DefaultManagedAssistantModel, "claude-opus-5-5", "deepseek-v4.1-flash", "glm-5.3", "gemini-3.8-flash"}

type AssistantModelProfile struct {
	Model      string `json:"model"`
	Capability string `json:"capability"`
	Protocol   string `json:"protocol"`
}

type AssistantChannel struct {
	ID            string                  `json:"id"`
	Name          string                  `json:"name"`
	BaseURL       string                  `json:"baseUrl"`
	APIKey        string                  `json:"apiKey"`
	CredentialRef string                  `json:"credentialRef"`
	Enabled       bool                    `json:"enabled"`
	Pinned        bool                    `json:"pinned"`
	Scope         string                  `json:"scope"`
	APIFormat     string                  `json:"apiFormat"`
	InterfaceType string                  `json:"interfaceType"`
	Models        []string                `json:"models"`
	ModelAliases  map[string]string       `json:"modelAliases"`
	ModelProfiles []AssistantModelProfile `json:"modelProfiles"`
}

type AssistantConfigSnapshot struct {
	Revision         int64              `json:"-"`
	AssistantModel   string             `json:"assistantModel"`
	MediaReviewModel string             `json:"mediaReviewModel"`
	TextModel        string             `json:"textModel"`
	ImageModel       string             `json:"imageModel"`
	VideoModel       string             `json:"videoModel"`
	AudioModel       string             `json:"audioModel"`
	BaseURL          string             `json:"baseUrl"`
	Channels         []AssistantChannel `json:"channels"`
}

// ManagedCredentialLookup fills hosted-channel secrets that are not stored in
// the local snapshot. The lookup is supplied by app; this domain never imports
// beefapi.
type ManagedCredentialLookup func(channelID, credentialRef, baseURL string) (apiKey, resolvedBaseURL string, ok bool)

func SplitModelKey(value string) (channelID, modelID string) {
	trimmed := strings.TrimSpace(value)
	if idx := strings.Index(trimmed, "::"); idx >= 0 {
		return strings.TrimSpace(trimmed[:idx]), strings.TrimSpace(trimmed[idx+2:])
	}
	return "", trimmed
}

func AssistantReasonMessage(reason string) string {
	switch reason {
	case AssistantReasonCredentialMissing:
		return "该渠道还没有可用的密钥"
	case AssistantReasonProtocolUnsupported:
		return "该模型的协议不支持内置助手会话"
	default:
		return "尚未选择可用的助手文本模型"
	}
}

func AssistantUnavailable(reason, message string) error {
	return &assistant.UnavailableError{Reason: reason, Message: message}
}

// ResolveAssistantProvider applies catalog selection to a loaded snapshot.
// Credential lookup for hosted channels is injected; secrets never appear in
// error messages.
func ResolveAssistantProvider(snapshot AssistantConfigSnapshot, lookup ManagedCredentialLookup) (assistant.Provider, error) {
	selection := strings.TrimSpace(snapshot.AssistantModel)
	if selection == "" {
		selection = strings.TrimSpace(snapshot.TextModel)
	}
	provider, reason := ResolveAssistantChannelModel(snapshot, selection, lookup)
	if reason != "" {
		return assistant.Provider{}, AssistantUnavailable(reason, AssistantReasonMessage(reason))
	}
	return provider, nil
}

func ResolveAssistantChannelModel(snapshot AssistantConfigSnapshot, modelKey string, lookup ManagedCredentialLookup) (assistant.Provider, string) {
	return resolveChannelModel(snapshot, modelKey, lookup, managedAssistantModels)
}

func resolveChannelModel(snapshot AssistantConfigSnapshot, modelKey string, lookup ManagedCredentialLookup, managedModels []string) (assistant.Provider, string) {
	if modelKey == "" {
		return assistant.Provider{}, AssistantReasonModelNotConfigured
	}
	channelID, modelID := SplitModelKey(modelKey)
	if modelID == "" {
		return assistant.Provider{}, AssistantReasonModelNotConfigured
	}
	channel, found := FindAssistantChannel(snapshot.Channels, channelID, modelID)
	if !found {
		return assistant.Provider{}, AssistantReasonModelNotConfigured
	}
	modelID = assistantModelAlias(channel, modelID)
	if !assistantChannelHasModel(channel, modelID) {
		return assistant.Provider{}, AssistantReasonModelNotConfigured
	}
	if channel.ID == "beefapi" && (channel.Pinned || channel.CredentialRef == "beefapi-enterprise") {
		allowed := false
		for _, candidate := range managedModels {
			if assistantModelAlias(channel, candidate) == modelID {
				allowed = true
				break
			}
		}
		if !allowed {
			return assistant.Provider{}, AssistantReasonModelNotConfigured
		}
	}
	protocol, protocolOK := ChannelModelProtocol(channel, modelID)
	if !protocolOK {
		protocol, protocolOK = defaultTextModelProtocol(snapshot, channel, modelID)
	}
	if !protocolOK {
		return assistant.Provider{}, AssistantReasonModelNotConfigured
	}
	if protocol == "" {
		return assistant.Provider{}, AssistantReasonProtocolUnsupported
	}
	provider := assistant.Provider{
		ChannelID: channel.ID, ChannelName: AssistantChannelName(channel),
		Model: modelID, ModelKey: modelKey, Protocol: protocol,
		BaseURL: strings.TrimSpace(channel.BaseURL), APIKey: strings.TrimSpace(channel.APIKey),
	}
	if provider.BaseURL == "" {
		provider.BaseURL = strings.TrimSpace(snapshot.BaseURL)
	}
	if lookup != nil {
		if apiKey, baseURL, ok := lookup(channel.ID, channel.CredentialRef, provider.BaseURL); ok {
			if strings.TrimSpace(apiKey) != "" {
				provider.APIKey = apiKey
			}
			if strings.TrimSpace(baseURL) != "" {
				provider.BaseURL = strings.TrimSpace(baseURL)
			}
		}
	}
	if provider.APIKey == "" {
		return assistant.Provider{}, AssistantReasonCredentialMissing
	}
	if provider.BaseURL == "" {
		return assistant.Provider{}, AssistantReasonModelNotConfigured
	}
	return provider, ""
}

func FindAssistantChannel(channels []AssistantChannel, channelID, modelID string) (AssistantChannel, bool) {
	if channelID != "" {
		for _, channel := range channels {
			if channel.ID == channelID && channel.Enabled {
				return channel, true
			}
		}
		return AssistantChannel{}, false
	}
	for _, channel := range channels {
		if !channel.Enabled {
			continue
		}
		if assistantChannelHasModel(channel, assistantModelAlias(channel, modelID)) {
			return channel, true
		}
	}
	return AssistantChannel{}, false
}

// A custom channel may only persist a models list. The user's default text
// selection supplies the capability in that case; explicit profiles still win.
func defaultTextModelProtocol(snapshot AssistantConfigSnapshot, channel AssistantChannel, modelID string) (string, bool) {
	if channel.Scope == "system" || channel.Pinned || channel.CredentialRef != "" {
		return "", false
	}
	for _, profile := range channel.ModelProfiles {
		if strings.TrimSpace(profile.Model) == modelID {
			return "", false
		}
	}
	textChannelID, textModelID := SplitModelKey(snapshot.TextModel)
	textChannel, found := FindAssistantChannel(snapshot.Channels, textChannelID, textModelID)
	if !found || textChannel.ID != channel.ID || assistantModelAlias(channel, textModelID) != modelID {
		return "", false
	}
	declared := strings.TrimSpace(channel.InterfaceType)
	if declared == "" {
		switch strings.TrimSpace(channel.APIFormat) {
		case "", "openai":
			declared = "chat-completion"
		case "claude":
			declared = "claude-api"
		default:
			return "", true
		}
	}
	return assistantProtocols[declared], true
}

func ChannelModelProtocol(channel AssistantChannel, modelID string) (string, bool) {
	for _, profile := range channel.ModelProfiles {
		if profile.Model != modelID {
			continue
		}
		capability := strings.TrimSpace(profile.Capability)
		if capability != "" && capability != "text" {
			return "", false
		}
		declared := strings.TrimSpace(profile.Protocol)
		if declared == "" {
			return "chat-completion", true
		}
		normalized, supported := assistantProtocols[declared]
		if !supported {
			return "", true
		}
		return normalized, true
	}
	return "", false
}

func AssistantChannelName(channel AssistantChannel) string {
	if name := strings.TrimSpace(channel.Name); name != "" {
		return name
	}
	return channel.ID
}

func AssistantGenerationModelKey(snapshot AssistantConfigSnapshot, kind string) (display string, modelKey string) {
	switch kind {
	case "image":
		modelKey = strings.TrimSpace(snapshot.ImageModel)
	case "video":
		modelKey = strings.TrimSpace(snapshot.VideoModel)
	case "audio":
		modelKey = strings.TrimSpace(snapshot.AudioModel)
	default:
		return "", ""
	}
	_, display = SplitModelKey(modelKey)
	return display, modelKey
}

// AssistantGenerationChoice 是一次生成提议要用的有效模型：节点显式设置优先于全局默认。
type AssistantGenerationChoice struct {
	Display      string
	ModelKey     string
	FromNode     bool
	KindMismatch bool
}

func ResolveAssistantGenerationModel(snapshot AssistantConfigSnapshot, kind, selectedModel string) AssistantGenerationChoice {
	kind = normalizeCapability(kind)
	selected := strings.TrimSpace(selectedModel)
	if selected != "" {
		normalized := normalizeAssistantGenerationModel(snapshot, selected)
		if normalized != "" {
			if assistantGenerationModelConflictsKind(snapshot, normalized, kind) {
				return AssistantGenerationChoice{KindMismatch: true}
			}
			if assistantGenerationModelMatchesKind(snapshot, normalized, kind) {
				_, display := SplitModelKey(normalized)
				return AssistantGenerationChoice{Display: display, ModelKey: normalized, FromNode: true}
			}
		}
		// An explicit but unresolved choice must never turn into a paid default.
		return AssistantGenerationChoice{}
	}
	display, modelKey := AssistantGenerationModelKey(snapshot, kind)
	return AssistantGenerationChoice{Display: display, ModelKey: modelKey}
}

func assistantGenerationModelMatchesKind(snapshot AssistantConfigSnapshot, modelKey, kind string) bool {
	if kind != "image" && kind != "video" && kind != "audio" {
		return false
	}
	modelKey = strings.TrimSpace(modelKey)
	if modelKey == "" {
		return false
	}
	_, defaultKey := AssistantGenerationModelKey(snapshot, kind)
	if modelKey == defaultKey {
		return true
	}
	capability, found := assistantGenerationModelCapability(snapshot, modelKey)
	return found && capability == kind
}

func assistantGenerationModelConflictsKind(snapshot AssistantConfigSnapshot, modelKey, kind string) bool {
	if kind != "image" && kind != "video" && kind != "audio" {
		return true
	}
	modelKey = strings.TrimSpace(modelKey)
	if modelKey == "" {
		return false
	}
	for _, other := range []string{"image", "video", "audio"} {
		if other == kind {
			continue
		}
		_, otherDefault := AssistantGenerationModelKey(snapshot, other)
		if otherDefault != "" && modelKey == otherDefault {
			return true
		}
	}
	capability, found := assistantGenerationModelCapability(snapshot, modelKey)
	if !found || capability == "" {
		return false
	}
	return capability != kind
}

func normalizeAssistantGenerationModel(snapshot AssistantConfigSnapshot, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	channelID, modelID := SplitModelKey(value)
	if modelID == "" {
		return ""
	}
	if channelID != "" {
		channel, ok := findEnabledAssistantChannel(snapshot, channelID)
		if !ok {
			return ""
		}
		resolved := assistantModelAlias(channel, modelID)
		if !assistantChannelHasModel(channel, resolved) {
			return ""
		}
		return encodeAssistantModelKey(channel.ID, resolved)
	}
	channel, ok := findEnabledAssistantChannelForModel(snapshot, modelID)
	if !ok {
		return ""
	}
	resolved := assistantModelAlias(channel, modelID)
	if !assistantChannelHasModel(channel, resolved) {
		return ""
	}
	return encodeAssistantModelKey(channel.ID, resolved)
}

func encodeAssistantModelKey(channelID, modelID string) string {
	channelID = strings.TrimSpace(channelID)
	modelID = strings.TrimSpace(modelID)
	if channelID == "" {
		return modelID
	}
	return channelID + "::" + modelID
}

func assistantModelAlias(channel AssistantChannel, modelID string) string {
	if alias := strings.TrimSpace(channel.ModelAliases[modelID]); alias != "" {
		return alias
	}
	return strings.TrimSpace(modelID)
}

func findEnabledAssistantChannel(snapshot AssistantConfigSnapshot, channelID string) (AssistantChannel, bool) {
	for _, channel := range snapshot.Channels {
		if channel.Enabled && channel.ID == channelID {
			return channel, true
		}
	}
	return AssistantChannel{}, false
}

func findEnabledAssistantChannelForModel(snapshot AssistantConfigSnapshot, modelID string) (AssistantChannel, bool) {
	for _, channel := range snapshot.Channels {
		if !channel.Enabled {
			continue
		}
		if assistantChannelHasModel(channel, assistantModelAlias(channel, modelID)) || assistantChannelHasModel(channel, modelID) {
			return channel, true
		}
	}
	return AssistantChannel{}, false
}

// assistantChannelHasModel 在渠道 models 有条目时按列表判定，与前端
// normalizeModelOptionValue 一致；列表缺省时回退 modelProfiles，兼容不完整快照。
func assistantChannelHasModel(channel AssistantChannel, modelID string) bool {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		return false
	}
	listed := false
	for _, name := range channel.Models {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		listed = true
		if name == modelID {
			return true
		}
	}
	if listed {
		return false
	}
	for _, profile := range channel.ModelProfiles {
		if strings.TrimSpace(profile.Model) == modelID {
			return true
		}
	}
	return false
}

func assistantGenerationModelCapability(snapshot AssistantConfigSnapshot, modelKey string) (string, bool) {
	channelID, modelID := SplitModelKey(modelKey)
	if modelID == "" {
		return "", false
	}
	for _, channel := range snapshot.Channels {
		if !channel.Enabled {
			continue
		}
		if channelID != "" && channel.ID != channelID {
			continue
		}
		for _, profile := range channel.ModelProfiles {
			if strings.TrimSpace(profile.Model) != modelID {
				continue
			}
			capability := assistantProfileCapability(profile)
			if capability == "" {
				return "", false
			}
			return capability, true
		}
	}
	return "", false
}

// assistantProfileCapability 显式 capability 优先；未标注时按协议推断。
// openai-image 等已迁出 host builtin 的插件协议仍能通过协议 ID 映射到 image。
func assistantProfileCapability(profile AssistantModelProfile) string {
	if capability := normalizeCapability(profile.Capability); capability != "" {
		return capability
	}
	protocolID := strings.TrimSpace(profile.Protocol)
	if protocolID == "" {
		return ""
	}
	if meta, ok := LookupFromRegistry(protocol.Builtins())(protocolID); ok {
		if capability := normalizeCapability(protocolCapabilityFromMetadata(meta)); capability != "" {
			return capability
		}
	}
	return normalizeCapability(capabilityFromTaskType(protocolID))
}
