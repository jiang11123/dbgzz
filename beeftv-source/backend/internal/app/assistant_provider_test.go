package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveAssistantProviderFromModelsOnlyLocalChannel(t *testing.T) {
	for _, selection := range []string{"deepseek-v4-flash:free", "newapi-local::deepseek-v4-flash:free"} {
		t.Run(selection, func(t *testing.T) {
			body, err := json.Marshal(map[string]any{
				"schemaVersion": 1, "revision": 1,
				"config": map[string]any{
					"textModel": selection,
					"channels": []any{map[string]any{
						"id": "newapi-local", "enabled": true, "apiFormat": "openai",
						"baseUrl": "http://127.0.0.1:3000/v1", "apiKey": "synthetic-local-key",
						"models": []string{"deepseek-v4-flash:free"},
					}},
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			service := writeAssistantConfig(t, string(body))
			provider, err := service.ResolveAssistantProvider()
			if err != nil {
				t.Fatalf("local models-only text selection must resolve without database rows: %v", err)
			}
			if provider.ChannelID != "newapi-local" || provider.Model != "deepseek-v4-flash:free" || provider.Protocol != "chat-completion" || provider.BaseURL != "http://127.0.0.1:3000/v1" || provider.APIKey != "synthetic-local-key" {
				t.Fatal("resolved provider does not match the persisted local channel")
			}
		})
	}
}

// 用户在设置里选的是「渠道内的某个模型」：凭据必须按那个渠道解析。
// 顶层 apiKey 在托管形态下永远是空串，只读顶层就会把可用的助手判成不可用（P1 缺陷）。
func writeAssistantConfig(t *testing.T, body string) *Service {
	t.Helper()
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "local-model-config.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return NewLocal(nil, dataDir)
}

func TestResolveAssistantProviderUsesChannelCredential(t *testing.T) {
	service := writeAssistantConfig(t, `{"schemaVersion":1,"revision":1,"config":{
		"apiKey":"","baseUrl":"https://enterprise.beefapi.com","textModel":"custom::my-text",
		"channels":[{"id":"custom","name":"自建","enabled":true,"apiKey":"channel-secret",
			"baseUrl":"https://relay.example.com/v1",
			"modelProfiles":[{"capability":"text","model":"my-text","protocol":"chat-completion"}]}]}}`)

	provider, err := service.ResolveAssistantProvider()
	if err != nil {
		t.Fatalf("应解析成功: %v", err)
	}
	if provider.ChannelID != "custom" || provider.Model != "my-text" || provider.Protocol != "chat-completion" {
		t.Fatalf("渠道模型解析错误: %#v", provider)
	}
	if provider.APIKey != "channel-secret" || provider.BaseURL != "https://relay.example.com/v1" {
		t.Fatalf("凭据与地址应来自渠道: channel=%s base=%s hasKey=%t", provider.ChannelID, provider.BaseURL, provider.APIKey != "")
	}
	if provider.ChannelName != "自建" {
		t.Fatalf("渠道名应可展示，得到 %q", provider.ChannelName)
	}
}

// assistantModel 优先于 textModel；协议来自该模型在渠道里的能力声明。
func TestResolveAssistantProviderPrefersAssistantModel(t *testing.T) {
	service := writeAssistantConfig(t, `{"schemaVersion":1,"revision":1,"config":{
		"assistantModel":"custom::claude-x","textModel":"custom::chat-x",
		"channels":[{"id":"custom","enabled":true,"apiKey":"k","baseUrl":"https://relay.example.com",
			"modelProfiles":[
				{"capability":"text","model":"chat-x","protocol":"chat-completion"},
				{"capability":"text","model":"claude-x","protocol":"claude-api"}]}]}}`)

	provider, err := service.ResolveAssistantProvider()
	if err != nil {
		t.Fatalf("应解析成功: %v", err)
	}
	if provider.Model != "claude-x" || provider.Protocol != "claude-api" {
		t.Fatalf("应使用 assistantModel 及其协议: %#v", provider)
	}
}

// 显式选择失效时要求重新选择，不能静默发送给另一模型。
func TestResolveAssistantProviderRejectsUnresolvableExplicitModel(t *testing.T) {
	service := writeAssistantConfig(t, `{"schemaVersion":1,"revision":1,"config":{
		"assistantModel":"gone::ghost-model","textModel":"custom::chat-x",
		"channels":[{"id":"custom","enabled":true,"apiKey":"k","baseUrl":"https://relay.example.com",
			"modelProfiles":[{"capability":"text","model":"chat-x","protocol":"chat-completion"}]}]}}`)

	provider, err := service.ResolveAssistantProvider()
	unavailable, ok := err.(*AssistantUnavailableError)
	if !ok || unavailable.Reason != AssistantReasonModelNotConfigured || provider.Model != "" || provider.APIKey != "" {
		t.Fatalf("显式失效模型应拒绝发送: %v", err)
	}
}

// 渠道能力表里文本模型没写协议时，按渠道层的缺省协议（chat-completion）处理。
func TestResolveAssistantProviderDefaultsMissingProtocolToChatCompletion(t *testing.T) {
	service := writeAssistantConfig(t, `{"schemaVersion":1,"revision":1,"config":{
		"textModel":"custom::chat-x",
		"channels":[{"id":"custom","enabled":true,"apiKey":"k","baseUrl":"https://relay.example.com",
			"modelProfiles":[{"capability":"text","model":"chat-x"}]}]}}`)

	provider, err := service.ResolveAssistantProvider()
	if err != nil {
		t.Fatalf("缺省协议应可用: %v", err)
	}
	if provider.Protocol != "chat-completion" {
		t.Fatalf("缺省协议应为 chat-completion，得到 %q", provider.Protocol)
	}
}

// 配置里历史上出现过 openai-response 的写法；它和 responses 是同一件事。
func TestResolveAssistantProviderNormalizesResponsesProtocol(t *testing.T) {
	service := writeAssistantConfig(t, `{"schemaVersion":1,"revision":1,"config":{
		"textModel":"custom::resp-x",
		"channels":[{"id":"custom","enabled":true,"apiKey":"k","baseUrl":"https://relay.example.com",
			"modelProfiles":[{"capability":"text","model":"resp-x","protocol":"openai-response"}]}]}}`)

	provider, err := service.ResolveAssistantProvider()
	if err != nil {
		t.Fatalf("应解析成功: %v", err)
	}
	if provider.Protocol != "responses" {
		t.Fatalf("协议应归一为 responses，得到 %q", provider.Protocol)
	}
}

func TestResolveAssistantProviderReasons(t *testing.T) {
	cases := []struct {
		name       string
		config     string
		wantReason string
	}{
		{"没有任何模型", `{"schemaVersion":1,"revision":1,"config":{"channels":[]}}`, AssistantReasonModelNotConfigured},
		{"渠道没有密钥", `{"schemaVersion":1,"revision":1,"config":{"textModel":"custom::chat-x","channels":[{"id":"custom","enabled":true,"apiKey":"","baseUrl":"https://relay.example.com","modelProfiles":[{"capability":"text","model":"chat-x","protocol":"chat-completion"}]}]}}`, AssistantReasonCredentialMissing},
		{"协议不支持", `{"schemaVersion":1,"revision":1,"config":{"textModel":"custom::img-x","channels":[{"id":"custom","enabled":true,"apiKey":"k","baseUrl":"https://relay.example.com","modelProfiles":[{"capability":"text","model":"img-x","protocol":"newapi-channel-1"}]}]}}`, AssistantReasonProtocolUnsupported},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			service := writeAssistantConfig(t, item.config)
			_, err := service.ResolveAssistantProvider()
			if err == nil {
				t.Fatal("应返回不可用原因")
			}
			unavailable, isUnavailable := err.(*AssistantUnavailableError)
			if !isUnavailable {
				t.Fatalf("错误类型应是 *AssistantUnavailableError，得到 %T", err)
			}
			if unavailable.Reason != item.wantReason {
				t.Fatalf("reason 应为 %s，得到 %s", item.wantReason, unavailable.Reason)
			}
		})
	}
}

// 付费生成提议要把画布默认模型原样告诉用户：展示名去掉渠道前缀，modelKey 保留原值。
func TestAssistantGenerationModelStripsChannelPrefix(t *testing.T) {
	service := writeAssistantConfig(t, `{"schemaVersion":1,"revision":1,"config":{"imageModel":"beefapi::gpt-image-2","videoModel":"beefapi::wan3.0-video"}}`)

	display, modelKey := service.AssistantGenerationModel("image")
	if display != "gpt-image-2" || modelKey != "beefapi::gpt-image-2" {
		t.Fatalf("图片模型解析错误: display=%q modelKey=%q", display, modelKey)
	}
	display, modelKey = service.AssistantGenerationModel("video")
	if display != "wan3.0-video" || modelKey != "beefapi::wan3.0-video" {
		t.Fatalf("视频模型解析错误: display=%q modelKey=%q", display, modelKey)
	}
	if display, _ := service.AssistantGenerationModel("audio"); display != "" {
		t.Fatalf("只支持 image/video，得到 %q", display)
	}
}
