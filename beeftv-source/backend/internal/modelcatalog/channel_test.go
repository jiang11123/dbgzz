package modelcatalog

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func TestNormalizeChannelModelContractAcceptsProtocolAlias(t *testing.T) {
	lookup := func(id string) (ProtocolMeta, bool) {
		if id == "google-gemini-generate-content" || id == "gemini-generate-content" {
			return ProtocolMeta{ID: "gemini-generate-content", Enabled: true, PrimaryCapability: "text"}, true
		}
		return ProtocolMeta{}, false
	}
	modelKey, providerKey, capability, proto, err := NormalizeChannelModelContract(lookup, &model.ModelChannel{}, ChannelModelRequest{
		ModelKey: "gemini-flash", Capability: "text", Protocol: "google-gemini-generate-content",
	})
	if err != nil {
		t.Fatalf("alias should resolve: %v", err)
	}
	if modelKey != "gemini-flash" || providerKey != "gemini-flash" || capability != "text" || proto != "gemini-generate-content" {
		t.Fatalf("unexpected contract %s %s %s %s", modelKey, providerKey, capability, proto)
	}
}

func TestLookupFromRegistryUsesResolveAlias(t *testing.T) {
	lookup := LookupFromRegistry(protocol.Builtins())
	_, _, _, proto, err := NormalizeChannelModelContract(lookup, &model.ModelChannel{APIKey: "k"}, ChannelModelRequest{
		ModelKey: "gpt-test", Capability: "text", Protocol: string(model.ChannelInterfaceChatCompletion),
	})
	if err != nil {
		t.Fatalf("builtin chat-completion should resolve: %v", err)
	}
	if proto != model.ChannelInterfaceChatCompletion {
		t.Fatalf("protocol = %s", proto)
	}
}

func TestNormalizeChannelModelContractRejectsUnknownProtocol(t *testing.T) {
	lookup := func(string) (ProtocolMeta, bool) { return ProtocolMeta{}, false }
	_, _, _, _, err := NormalizeChannelModelContract(lookup, &model.ModelChannel{}, ChannelModelRequest{
		ModelKey: "x", Capability: "image", Protocol: "not-a-protocol",
	})
	if err == nil || !strings.Contains(err.Error(), "请选择有效的模型请求协议") {
		t.Fatalf("unknown protocol should fail closed, got %v", err)
	}
}

func TestCascadeUpstreamRenameFollowsImplicitTiersOnly(t *testing.T) {
	tiers := []model.ChannelModelVariant{
		{ProviderModelKey: "old-sku"},
		{ProviderModelKey: "explicit-other"},
	}
	result := CascadeUpstreamRename(tiers, "old-sku", "new-sku")
	if result[0].ProviderModelKey != "new-sku" {
		t.Fatalf("implicit tier should follow rename, got %q", result[0].ProviderModelKey)
	}
	if result[1].ProviderModelKey != "explicit-other" {
		t.Fatalf("explicit other SKU must stay, got %q", result[1].ProviderModelKey)
	}
}

func TestFixedVideoResolutionAppliedToSingleSKU(t *testing.T) {
	profile := &VideoCapabilityConfig{Resolutions: []string{"720p"}}
	input := TaskInput{Mode: "video", Config: TaskConfig{VQuality: "auto"}}
	ApplyFixedVideoResolution(&input, profile)
	if input.Config.VQuality != "720p" {
		t.Fatalf("single SKU should pin vquality, got %q", input.Config.VQuality)
	}
}

func TestCredentialAbsenceDoesNotLeakSecret(t *testing.T) {
	snapshot := AssistantConfigSnapshot{
		AssistantModel: "custom::chat-x",
		Channels: []AssistantChannel{{
			ID: "custom", Name: "自建", Enabled: true, BaseURL: "https://relay.example.com",
			ModelProfiles: []AssistantModelProfile{{Capability: "text", Model: "chat-x", Protocol: "chat-completion"}},
		}},
	}
	_, err := ResolveAssistantProvider(snapshot, nil)
	if err == nil {
		t.Fatal("missing credential should fail")
	}
	if !strings.Contains(err.Error(), "该渠道还没有可用的密钥") {
		t.Fatalf("user-facing error = %v", err)
	}
	if strings.Contains(err.Error(), "sk-") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("error leaked credential material: %v", err)
	}
}

func TestAssistantUnavailableWhenChannelDisabled(t *testing.T) {
	snapshot := AssistantConfigSnapshot{
		AssistantModel: "custom::chat-x",
		TextModel:      "custom::chat-x",
		Channels: []AssistantChannel{{
			ID: "custom", Enabled: false, APIKey: "secret-key", BaseURL: "https://relay.example.com",
			ModelProfiles: []AssistantModelProfile{{Capability: "text", Model: "chat-x", Protocol: "chat-completion"}},
		}},
	}
	_, err := ResolveAssistantProvider(snapshot, nil)
	if err == nil {
		t.Fatal("disabled channel should be unconfigured")
	}
	if strings.Contains(err.Error(), "secret-key") {
		t.Fatalf("disabled-channel error leaked key: %v", err)
	}
}
