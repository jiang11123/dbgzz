package assistantruntime

import (
	"errors"
	"os"
	"strings"

	"infinite-canvas/backend/internal/assistant"
)

// ProviderService 是宿主解析模型/凭据时需要的窄端口；*app.Service 满足该接口。
type ProviderService interface {
	DataDir() string
	ResolveAssistantProvider() (assistant.Provider, error)
}

// ResolveProvider 允许显式环境变量覆盖渠道解析（开发与受控测试路径）。
// 实际渠道选择算法仍由 app 拥有，通过 resolve 注入。
//
// 失败时返回的 reason 直接就是 /assistant/status 契约里的机器可读原因。
func ResolveProvider(resolve func() (assistant.Provider, error)) (assistant.Provider, string) {
	override := assistant.Provider{
		BaseURL:  strings.TrimSpace(os.Getenv("BEEFTV_AGENT_BASE_URL")),
		APIKey:   strings.TrimSpace(os.Getenv("BEEFTV_AGENT_API_KEY")),
		Model:    strings.TrimSpace(os.Getenv("BEEFTV_AGENT_MODEL")),
		Protocol: strings.TrimSpace(os.Getenv("BEEFTV_AGENT_PROTOCOL")),
	}
	if override.BaseURL != "" && override.APIKey != "" && override.Model != "" {
		if override.Protocol == "" {
			override.Protocol = "chat-completion"
		}
		override.ChannelID = "env"
		override.ChannelName = "环境变量"
		override.ModelKey = override.Model
		return override, ""
	}
	if resolve == nil {
		return assistant.Provider{}, assistant.ReasonModelNotConfigured
	}
	provider, err := resolve()
	if err != nil {
		var unavailable *assistant.UnavailableError
		if errors.As(err, &unavailable) {
			return assistant.Provider{}, unavailable.Reason
		}
		return assistant.Provider{}, assistant.ReasonModelNotConfigured
	}
	return provider, ""
}

func (h *Host) ResolveProvider() (assistant.Provider, string) {
	if h != nil && h.opts.ResolveProvider != nil {
		return h.opts.ResolveProvider()
	}
	return ResolveProvider(nil)
}
