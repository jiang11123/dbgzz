package app

import (
	"context"
	"os"
	"testing"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/protocol"
)

func TestManagedGeminiCatalogCredentialProviderChain(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","baseUrl":"https://enterprise.beefapi.com","apiKey":"test-only-key"}]}`)); err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile("../../../plugin-packages/google-gemini-generate-content/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	adapters, err := protocol.LoadInstalledProviders(manifest, nil)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := protocol.NewRegistry(adapters...)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"gemini-generate-content", "google-gemini-generate-content"} {
		resolved, err := s.resolveManagedBeefAPISecrets(map[string]any{"config": map[string]any{"channelId": "beefapi", "credentialRef": beefapi.CredentialRef, "interfaceType": id}})
		if err != nil {
			t.Fatal(err)
		}
		config := resolved["config"].(map[string]any)
		if config["apiKey"] != "test-only-key" || config["baseUrl"] != "https://enterprise.beefapi.com" {
			t.Fatal("managed credential did not resolve")
		}
		adapter, ok := registry.Resolve(config["interfaceType"].(string))
		if !ok || adapter.Metadata().ID != "gemini-generate-content" {
			t.Fatalf("provider %q did not resolve", id)
		}
		agent, ok := adapter.(protocol.AgentAdapter)
		if !ok {
			t.Fatal("Gemini text adapter unavailable")
		}
		spec, err := agent.BuildAgent(context.Background(), protocol.AgentRequestContext{Model: "gemini-test"})
		if err != nil {
			t.Fatal(err)
		}
		if spec.Path != "/v1beta/models/gemini-test:generateContent" {
			t.Fatalf("unexpected native path %q", spec.Path)
		}
	}
}

func TestCustomRelayOnlyInjectsBeefAPIKeyForExactConfiguredOrigin(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","baseUrl":"https://enterprise.beefapi.com","apiKey":"disk-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{
		"http://enterprise.beefapi.com/v1/chat/completions",
		"https://enterprise.beefapi.com:8443/v1/chat/completions",
		"https://127.0.0.1.attacker.example/v1/chat/completions",
		"http://127.0.0.1:9999/v1/chat/completions",
		"http://localhost:9999/v1/chat/completions",
		"https://enterprise.beefapi.com.attacker.example/v1/chat/completions",
		"https://user@enterprise.beefapi.com/v1/chat/completions",
	} {
		t.Run(target, func(t *testing.T) {
			got, err := s.ResolveCustomRelayAPIKey(target, "other-channel-key")
			if err != nil || got != "other-channel-key" {
				t.Fatalf("unrelated origin credential was replaced: error=%v", err)
			}
		})
	}
	got, err := s.ResolveCustomRelayAPIKey("https://enterprise.beefapi.com/v1/chat/completions", "")
	if err != nil || got != "disk-secret" {
		t.Fatalf("configured origin did not resolve its credential: error=%v", err)
	}
}

func TestResolveManagedBeefAPISecretsUsesStoredKeyAndDropsClientSentinel(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","baseUrl":"https://enterprise.beefapi.com","apiKey":"disk-secret","enabled":true,"models":["text-local"]}]}`)); err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"config": map[string]any{"channelId": "beefapi", "credentialRef": beefapi.CredentialRef, "apiKey": "from-webview", "baseUrl": "https://enterprise.beefapi.com", "model": "text-local"}}
	resolved, err := s.resolveManagedBeefAPISecrets(input)
	if err != nil {
		t.Fatal(err)
	}
	config := resolved["config"].(map[string]any)
	if config["apiKey"] != "disk-secret" {
		t.Fatalf("apiKey = %#v", config["apiKey"])
	}
	if _, exists := config["channelId"]; exists {
		t.Fatalf("system channel id leaked: %#v", config)
	}
	if config["credentialRef"] != beefapi.CredentialRef {
		t.Fatalf("credentialRef = %#v", config["credentialRef"])
	}
}

func TestChannelCatalogManagedCredentialPinsOrigin(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","baseUrl":"https://enterprise.beefapi.com","apiKey":"test-only-key"}]}`)); err != nil {
		t.Fatal(err)
	}
	for _, input := range []ChannelModelsRequest{
		{CredentialRef: beefapi.CredentialRef, ChannelID: "other", BaseURL: "https://attacker.example/v1"},
		{ChannelID: beefapi.ChannelID, BaseURL: "https://attacker.example/v1"},
		{BaseURL: "https://enterprise.beefapi.com/v1"},
	} {
		if err := s.resolveChannelModelsRequest(&input); err != nil {
			t.Fatal(err)
		}
		if input.BaseURL != "https://enterprise.beefapi.com" || input.APIKey != "test-only-key" {
			t.Fatal("stored credential not bound to configured origin")
		}
	}
	input := ChannelModelsRequest{ChannelID: "other", BaseURL: "https://custom.example/v1", APIKey: "custom-key"}
	if err := s.resolveChannelModelsRequest(&input); err != nil {
		t.Fatal(err)
	}
	if input.BaseURL != "https://custom.example/v1" || input.APIKey != "custom-key" {
		t.Fatal("unrelated custom channel changed")
	}
}
