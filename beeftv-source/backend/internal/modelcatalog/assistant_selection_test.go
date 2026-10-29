package modelcatalog

import "testing"

func TestModelsOnlyDefaultTextSelectionBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name     string
		change   func(*AssistantConfigSnapshot)
		protocol string
		reason   string
	}{
		{name: "openai", protocol: "chat-completion"},
		{name: "claude", change: func(s *AssistantConfigSnapshot) { s.Channels[0].APIFormat = "claude" }, protocol: "claude-api"},
		{name: "channel protocol", change: func(s *AssistantConfigSnapshot) { s.Channels[0].InterfaceType = "openai-response" }, protocol: "responses"},
		{name: "unsupported format", change: func(s *AssistantConfigSnapshot) { s.Channels[0].APIFormat = "gemini" }, reason: AssistantReasonProtocolUnsupported},
		{name: "unsupported channel protocol", change: func(s *AssistantConfigSnapshot) { s.Channels[0].InterfaceType = "openai-image" }, reason: AssistantReasonProtocolUnsupported},
		{name: "disabled", change: func(s *AssistantConfigSnapshot) { s.Channels[0].Enabled = false }, reason: AssistantReasonModelNotConfigured},
		{name: "missing key", change: func(s *AssistantConfigSnapshot) { s.Channels[0].APIKey = "" }, reason: AssistantReasonCredentialMissing},
		{name: "unlisted model", change: func(s *AssistantConfigSnapshot) { s.Channels[0].Models = []string{"other"} }, reason: AssistantReasonModelNotConfigured},
		{name: "system channel", change: func(s *AssistantConfigSnapshot) { s.Channels[0].Scope = "system" }, reason: AssistantReasonModelNotConfigured},
		{name: "managed credential", change: func(s *AssistantConfigSnapshot) { s.Channels[0].CredentialRef = "managed" }, reason: AssistantReasonModelNotConfigured},
		{name: "explicit unclassified selection", change: func(s *AssistantConfigSnapshot) { s.AssistantModel = "custom::other" }, reason: AssistantReasonModelNotConfigured},
		{name: "explicit image capability", change: func(s *AssistantConfigSnapshot) {
			s.Channels[0].ModelProfiles = []AssistantModelProfile{{Model: "local-text", Capability: "image", Protocol: "openai-image"}}
		}, reason: AssistantReasonModelNotConfigured},
		{name: "explicit unsupported protocol", change: func(s *AssistantConfigSnapshot) {
			s.Channels[0].ModelProfiles = []AssistantModelProfile{{Model: "local-text", Capability: "text", Protocol: "unsupported"}}
		}, reason: AssistantReasonProtocolUnsupported},
		{name: "explicit supported profile wins", change: func(s *AssistantConfigSnapshot) {
			s.Channels[0].ModelProfiles = []AssistantModelProfile{{Model: "local-text", Capability: "text", Protocol: "claude-api"}}
		}, protocol: "claude-api"},
		{name: "other channel default", change: func(s *AssistantConfigSnapshot) {
			s.TextModel = "other::local-text"
			s.Channels = append(s.Channels, AssistantChannel{ID: "other", Enabled: true, Models: []string{"local-text"}})
		}, reason: AssistantReasonModelNotConfigured},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := AssistantConfigSnapshot{TextModel: "custom::local-text", AssistantModel: "custom::local-text", Channels: []AssistantChannel{{ID: "custom", Enabled: true, APIFormat: "openai", APIKey: "synthetic", BaseURL: "http://127.0.0.1:3000/v1", Models: []string{"local-text", "other"}}}}
			if tc.change != nil {
				tc.change(&s)
			}
			provider, reason := ResolveAssistantChannelModel(s, s.AssistantModel, nil)
			if reason != tc.reason || provider.Protocol != tc.protocol {
				t.Fatalf("got reason=%q protocol=%q; want reason=%q protocol=%q", reason, provider.Protocol, tc.reason, tc.protocol)
			}
			if reason != "" && (provider.APIKey != "" || provider.BaseURL != "") {
				t.Fatal("rejected provider leaked connection information")
			}
		})
	}
}

func TestManagedGeminiAssistantUsesCatalogAndPreservesExplicitSelection(t *testing.T) {
	c := AssistantChannel{ID: "beefapi", Pinned: true, Enabled: true, APIKey: "synthetic", BaseURL: "https://example.test", Models: []string{"gemini-3.8-flash", "claude-opus-5-5"}, ModelProfiles: []AssistantModelProfile{{Model: "gemini-3.8-flash", Capability: "text", Protocol: "chat-completion"}, {Model: "claude-opus-5-5", Capability: "text"}}}
	s := AssistantConfigSnapshot{TextModel: "beefapi::gemini-3.8-flash", Channels: []AssistantChannel{c}}
	got, err := ResolveAssistantProvider(s, nil)
	if err != nil || got.Model != "gemini-3.8-flash" || got.Protocol != "chat-completion" {
		t.Fatalf("Gemini default unavailable: %v %#v", err, got)
	}
	s.AssistantModel = "beefapi::claude-opus-5-5"
	got, err = ResolveAssistantProvider(s, nil)
	if err != nil || got.Model != "claude-opus-5-5" {
		t.Fatalf("explicit selection replaced: %v %#v", err, got)
	}
	s.AssistantModel = ""
	s.Channels[0].Models = []string{"claude-opus-5-5"}
	if _, err := ResolveAssistantProvider(s, nil); err == nil {
		t.Fatal("removed Gemini silently used another model")
	}
}

func TestManagedAssistantSelectionDoesNotBypassCuratedModels(t *testing.T) {
	c := AssistantChannel{ID: "beefapi", Pinned: true, Enabled: true, APIKey: "synthetic", BaseURL: "https://example.test", Models: []string{"qwen", "claude-opus-5-5"}, ModelProfiles: []AssistantModelProfile{{Model: "qwen", Capability: "text"}, {Model: "claude-opus-5-5", Capability: "text"}}}
	s := AssistantConfigSnapshot{TextModel: "beefapi::qwen", Channels: []AssistantChannel{c}}
	if _, err := ResolveAssistantProvider(s, nil); err == nil {
		t.Fatal("text fallback bypassed curated models")
	}
	s.TextModel = "beefapi::claude-opus-5-5"
	s.AssistantModel = "beefapi::missing"
	if _, err := ResolveAssistantProvider(s, nil); err == nil {
		t.Fatal("explicit unavailable model silently fell back")
	}
	s.AssistantModel = "beefapi::claude-opus-5-5"
	got, err := ResolveAssistantProvider(s, nil)
	if err != nil || got.Model != "claude-opus-5-5" {
		t.Fatalf("selection not effective: %v %#v", err, got)
	}
	s.Channels[0].Models = append(s.Channels[0].Models, "gpt-6.1-sol")
	s.Channels[0].ModelProfiles = append(s.Channels[0].ModelProfiles, AssistantModelProfile{Model: "gpt-6.1-sol", Capability: "text"})
	s.AssistantModel = "beefapi::gpt-6.1-sol"
	if _, err := ResolveAssistantProvider(s, nil); err == nil {
		t.Fatal("deferred model became available merely through catalog membership")
	}
	s.Channels[0].ID = "custom"
	s.AssistantModel = "custom::qwen"
	if _, err := ResolveAssistantProvider(s, nil); err != nil {
		t.Fatal("custom channel was restricted", err)
	}
}

func TestManagedAssistantResolvesOnlyDeclaredAvailableAliases(t *testing.T) {
	c := AssistantChannel{ID: "beefapi", Pinned: true, Enabled: true, APIKey: "synthetic", BaseURL: "https://example.test", Models: []string{"opus-live"}, ModelAliases: map[string]string{"claude-opus-5-5": "opus-live"}, ModelProfiles: []AssistantModelProfile{{Model: "opus-live", Capability: "text", Protocol: "claude-api"}}}
	s := AssistantConfigSnapshot{AssistantModel: "beefapi::claude-opus-5-5", Channels: []AssistantChannel{c}}
	got, err := ResolveAssistantProvider(s, nil)
	if err != nil || got.Model != "opus-live" {
		t.Fatalf("alias not resolved: %v %#v", err, got)
	}
	s.Channels[0].Models = []string{"other"}
	if _, err := ResolveAssistantProvider(s, nil); err == nil {
		t.Fatal("unavailable alias accepted")
	}
}
