package assistantruntime

import (
	"os"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/assistant"
	"infinite-canvas/backend/internal/desktopnet"
)

type childPin struct {
	Port       int
	Nonce      string
	ListenFD   string
	Lifetime   bool
	OpsURL     string
	DesktopTok string
}

func (h *Host) buildEnv(provider assistant.Provider, pin childPin) []string {
	env := desktopnet.NodeProxyEnvironment(filterInheritedEnv(h.environ()), provider.BaseURL)
	set := func(key, value string) {
		env = setEnvValue(env, key, value)
	}
	set("BEEFTV_AGENT_DATA_DIR", h.dataDir())
	set("BEEFTV_AGENT_MODEL", provider.Model)
	set("BEEFTV_AGENT_BASE_URL", hostBaseURL(provider.BaseURL, provider.Protocol))
	set("BEEFTV_AGENT_API", hostAPI(provider.Protocol))
	set("BEEFTV_OPS_URL", opsBaseURL(pin.OpsURL, h.backendAddr()))
	set("BEEFTV_AGENT_HOST_TOKEN", h.hostToken())
	set("BEEFTV_AGENT_DESKTOP_TOKEN", pin.DesktopTok)
	set("BEEFTV_AGENT_API_KEY", provider.APIKey)
	if pin.Port > 0 {
		set("BEEFTV_AGENT_PORT", strconv.Itoa(pin.Port))
	} else {
		set("BEEFTV_AGENT_PORT", "")
	}
	set("BEEFTV_AGENT_INSTANCE_NONCE", pin.Nonce)
	set("BEEFTV_AGENT_LISTEN_FD", pin.ListenFD)
	if pin.Lifetime {
		set("BEEFTV_AGENT_LIFETIME_STDIN", "1")
	} else {
		set("BEEFTV_AGENT_LIFETIME_STDIN", "")
	}
	set("BEEFTV_OWNER_TOKEN", "")
	set("BEEFTV_AGENT_HOST_URL", "")
	return env
}

func filterInheritedEnv(inherited []string) []string {
	out := make([]string, 0, len(inherited))
	for _, entry := range inherited {
		key, _, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		if stripInheritedKey(key) {
			continue
		}
		out = append(out, entry)
	}
	return out
}

func stripInheritedKey(key string) bool {
	upper := strings.ToUpper(strings.TrimSpace(key))
	switch upper {
	case "BEEFTV_OWNER_TOKEN", "BEEFTV_OPS_URL", "BEEFTV_AGENT_HOST_URL":
		return true
	case "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION":
		return true
	case "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN":
		return true
	case "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY":
		return true
	case "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT":
		return true
	case "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN":
		return true
	case "XAI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "TOGETHER_API_KEY",
		"FIREWORKS_API_KEY", "DEEPSEEK_API_KEY", "COHERE_API_KEY", "PERPLEXITY_API_KEY",
		"CLAUDE_API_KEY", "NPM_TOKEN", "NODE_AUTH_TOKEN":
		return true
	}
	if strings.HasPrefix(upper, "BEEFTV_AGENT_") {
		return !agentTunableKey(upper)
	}
	return false
}

// agentTunableKey is a non-authority child setting (timeouts, budgets, origin).
// Credentials, listen identity, model, and ops URL are never tunables.
func agentTunableKey(upper string) bool {
	switch upper {
	case "BEEFTV_AGENT_MAX_TOKENS", "BEEFTV_AGENT_CONTEXT_WINDOW",
		"BEEFTV_AGENT_TURN_TIMEOUT_MS", "BEEFTV_AGENT_MAX_REQUESTS_PER_TURN",
		"BEEFTV_AGENT_MAX_TOOL_STEPS_PER_TURN", "BEEFTV_AGENT_TOTAL_REQUEST_BUDGET",
		"BEEFTV_AGENT_ALLOWED_ORIGIN", "BEEFTV_AGENT_READ_ONLY",
		"BEEFTV_AGENT_MAX_REQUESTS", "BEEFTV_AGENT_THINKING":
		return true
	}
	return false
}

func setEnvValue(env []string, key, value string) []string {
	prefix := key + "="
	kept := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			continue
		}
		kept = append(kept, entry)
	}
	return append(kept, key+"="+value)
}

func envValue(env []string, key string) string {
	prefix := key + "="
	got := ""
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			got = strings.TrimPrefix(entry, prefix)
		}
	}
	return got
}

func envHasKey(env []string, key string) bool {
	prefix := key + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return true
		}
	}
	return false
}

// hostAPI 把渠道协议映射成 pi-ai 的 API 适配器名；宿主按它构造模型定义。
func hostAPI(protocol string) string {
	switch protocol {
	case "claude-api":
		return "anthropic-messages"
	case "responses":
		return "openai-responses"
	default:
		return "openai-completions"
	}
}

// hostBaseURL 按适配器约定整理接口地址：
// OpenAI 兼容 SDK 会在 baseURL 后直接拼 /chat/completions 或 /responses，所以要带 /v1；
// Anthropic SDK 自己拼 /v1/messages，所以要去掉 /v1。渠道配置里两种写法都可能出现。
func hostBaseURL(baseURL, protocol string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return ""
	}
	hasV1 := strings.HasSuffix(trimmed, "/v1")
	if hostAPI(protocol) == "anthropic-messages" {
		if hasV1 {
			return strings.TrimSuffix(trimmed, "/v1")
		}
		return trimmed
	}
	if hasV1 {
		return trimmed
	}
	return trimmed + "/v1"
}

// opsBaseURL 规范化操作层基址：显式传入的（真实监听地址/请求地址）优先，
// 没有时退回环境变量推导，保证既有部署方式不被打断。
func opsBaseURL(explicit, backendAddr string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(explicit), "/")
	if trimmed == "" {
		return "http://127.0.0.1:" + strconv.Itoa(backendPort(backendAddr)) + "/api"
	}
	if !strings.HasSuffix(trimmed, "/api") {
		trimmed += "/api"
	}
	return trimmed
}

func backendPort(backendAddr string) int {
	if value := strings.TrimSpace(backendAddr); value != "" {
		if idx := strings.LastIndex(value, ":"); idx >= 0 {
			if port, err := strconv.Atoi(value[idx+1:]); err == nil {
				return port
			}
		}
	}
	return 8080
}

func (h *Host) environ() []string {
	if h != nil && h.opts.Environ != nil {
		return append([]string{}, h.opts.Environ()...)
	}
	return os.Environ()
}

func (h *Host) backendAddr() string {
	if h != nil && h.opts.BackendAddr != nil {
		return h.opts.BackendAddr()
	}
	return os.Getenv("CANVAS_BACKEND_ADDR")
}

func (h *Host) hostToken() string {
	if h != nil && h.opts.HostToken != nil {
		return strings.TrimSpace(h.opts.HostToken())
	}
	return ReadHostToken(h.dataDir())
}
