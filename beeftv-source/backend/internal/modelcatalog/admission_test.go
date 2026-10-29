package modelcatalog

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func TestTaskInputUsesWorkflowProvider(t *testing.T) {
	tests := []struct {
		name  string
		input map[string]any
		want  bool
	}{
		{name: "runninghub workflow", input: map[string]any{"config": map[string]any{"interfaceType": "runninghub-workflow-video"}}, want: true},
		{name: "case insensitive", input: map[string]any{"config": map[string]any{"interfaceType": "RunningHub-Workflow-Audio"}}, want: true},
		{name: "ordinary model", input: map[string]any{"config": map[string]any{"interfaceType": "openai-image", "channelId": "system-1", "model": "image-model"}}, want: false},
		{name: "system channel cannot forge workflow", input: map[string]any{"config": map[string]any{"interfaceType": "runninghub-workflow-image", "channelId": "system-1"}}, want: false},
		{name: "missing config", input: map[string]any{}, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := TaskInputUsesWorkflowProvider(test.input); got != test.want {
				t.Fatalf("TaskInputUsesWorkflowProvider() = %v, want %v", got, test.want)
			}
			if test.want && TaskInputUsesCustomChannel(test.input) {
				t.Fatal("workflow input must not be classified as a custom channel")
			}
		})
	}
}

func TestTaskInputUsesCustomChannelManagedBeefAPI(t *testing.T) {
	withCreds := map[string]any{"config": map[string]any{
		"credentialRef": beefapi.CredentialRef,
		"baseUrl":       "https://api.beefapi.example/v1",
		"apiKey":        "managed-key",
	}}
	if !TaskInputUsesCustomChannel(withCreds) {
		t.Fatal("managed BeefAPI with live credentials must be classified as a custom channel")
	}
	channelIDOnly := map[string]any{"config": map[string]any{"channelId": beefapi.ChannelID, "model": "x"}}
	if TaskInputUsesCustomChannel(channelIDOnly) {
		t.Fatal("beefapi channel id without credentials is not a custom channel")
	}
	if !TaskInputUsesSystemChannel(channelIDOnly) {
		t.Fatal("beefapi channel id without credentials still names a system channel")
	}
}

func TestSelectTaskModelRequiresLogicalModelWithoutExplicitChannel(t *testing.T) {
	_, err := SelectTaskModel(TaskSelectRequest{
		Input:           map[string]any{"mode": "video", "config": map[string]any{"model": "agnes-video-2.5"}},
		Type:            "canvas_video",
		FrontendEnabled: true,
	}, TaskSelectLookup{})
	assertModelError(t, err, ErrCodeInvalidModelSelection, "logicalModelId")
}

func TestSelectTaskModelAllowsCustomChannelWhenFrontendEnabled(t *testing.T) {
	input := map[string]any{
		"mode": "image",
		"config": map[string]any{
			"baseUrl":       "https://images.example.com/v1",
			"apiKey":        "custom-key",
			"interfaceType": "openai-image",
			"model":         "custom-image-model",
		},
	}
	result, err := SelectTaskModel(TaskSelectRequest{
		Input: input, Type: "canvas_image", Operation: "image", FrontendEnabled: true,
	}, TaskSelectLookup{})
	if err != nil {
		t.Fatalf("SelectTaskModel() error = %v", err)
	}
	if result.Routed != nil || result.Input["config"] == nil {
		t.Fatalf("SelectTaskModel() routed = %#v, input = %#v", result.Routed, result.Input)
	}
}

func TestSelectTaskModelRejectsLeftoverLogicalModelID(t *testing.T) {
	_, err := SelectTaskModel(TaskSelectRequest{
		Input: map[string]any{
			"mode": "image",
			"config": map[string]any{
				"baseUrl": "https://images.example.com/v1",
				"apiKey":  "custom-key",
				"model":   "custom-image-model",
			},
		},
		LogicalModelID:  "stale-logical",
		Type:            "canvas_image",
		FrontendEnabled: true,
	}, TaskSelectLookup{})
	assertModelError(t, err, ErrCodeModelCatalogMismatch, "模型目录已更新")
}

func TestSelectTaskModelRebuildsAuthoritativeExecutionSpec(t *testing.T) {
	channel, channelModel, lookup := imageSelectionLookup(t)
	input := map[string]any{
		"mode": "image",
		"config": map[string]any{
			"channelId":        channel.ID,
			"model":            channelModel.ModelKey,
			"quality":          "2k",
			"variantId":        "client-tier",
			"providerModelKey": "client-provider-model",
			"interfaceType":    "runninghub-workflow-image",
			"apiFormat":        "client-format",
			"baseUrl":          "https://attacker.invalid/v1",
			"apiKey":           "client-api-key",
			"secretKey":        "client-secret",
			"headers":          []any{map[string]any{"name": "Authorization", "value": "client-token"}},
			"capabilityConfig": map[string]any{"image": map[string]any{"maxOutputs": 99}},
		},
		"capabilityOptions": map[string]any{"quality": "1k", "size": "1:1"},
	}
	result, err := SelectTaskModel(TaskSelectRequest{
		Input: input, Type: "canvas_image", FrontendEnabled: true,
	}, lookup)
	if err != nil {
		t.Fatalf("SelectTaskModel() error = %v", err)
	}
	if result.Routed != nil {
		t.Fatalf("system channel must not bind a frontend route: %#v", result.Routed)
	}
	config := result.Input["config"].(map[string]any)
	for _, forbidden := range []string{"baseUrl", "apiKey", "secretKey", "headers", "capabilityConfig"} {
		if _, exists := config[forbidden]; exists {
			t.Fatalf("config[%q] must be removed from a system-channel request: %#v", forbidden, config[forbidden])
		}
	}
	if config["quality"] != "1k" {
		t.Fatalf("quality = %#v, want capabilityOptions value 1k", config["quality"])
	}
	if config["variantId"] != "tier-1k" {
		t.Fatalf("variantId = %#v, want server-selected tier-1k", config["variantId"])
	}
	if config["providerModelKey"] != "provider-image-1k" {
		t.Fatalf("providerModelKey = %#v, want server-selected provider-image-1k", config["providerModelKey"])
	}
	if config["interfaceType"] != string(model.ChannelInterfaceGrokImage) {
		t.Fatalf("interfaceType = %#v, want %q", config["interfaceType"], model.ChannelInterfaceGrokImage)
	}
	if config["apiFormat"] != "openai" {
		t.Fatalf("apiFormat = %#v, want openai", config["apiFormat"])
	}
	options := result.Input["capabilityOptions"].(map[string]any)
	if options["quality"] != config["quality"] || options["size"] != config["size"] || options["count"] != config["count"] {
		t.Fatalf("capabilityOptions and provider config diverged: options=%#v config=%#v", options, config)
	}
}

func TestSelectTaskModelAppliesServerDefaults(t *testing.T) {
	channel, channelModel, lookup := imageSelectionLookup(t)
	result, err := SelectTaskModel(TaskSelectRequest{
		Input: map[string]any{
			"mode":   "image",
			"config": map[string]any{"channelId": channel.ID, "model": channelModel.ModelKey},
		},
		Type: "canvas_image",
	}, lookup)
	if err != nil {
		t.Fatalf("SelectTaskModel() error = %v", err)
	}
	config := result.Input["config"].(map[string]any)
	if config["size"] != "1:1" || config["quality"] != "2k" || config["count"] != "1" || config["transparentBackground"] != "false" {
		t.Fatalf("server defaults were not applied: %#v", config)
	}
	if config["variantId"] != "tier-2k" || config["providerModelKey"] != "provider-image-2k" {
		t.Fatalf("server price selection was not persisted: %#v", config)
	}
}

func TestSelectTaskModelIgnoresStaleQualityWhenUnsupported(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGeminiImage), "nano-banana-pro")
	profile.Image.Quality = ImageQualityConfig{Supported: false, Default: "auto"}
	channel, channelModel, lookup := selectionLookup(t, "image", model.ChannelInterfaceGeminiImage, profile, []model.ChannelModelVariant{
		{ID: "tier-any", SelectorKey: `{}`, SelectorJSON: `{}`, ProviderModelKey: "provider-image", Enabled: true},
	})
	result, err := SelectTaskModel(TaskSelectRequest{
		Input: map[string]any{
			"mode": "image",
			"config": map[string]any{
				"channelId": channel.ID,
				"model":     channelModel.ModelKey,
				"quality":   "high",
				"size":      "16:9",
			},
		},
		Type: "canvas_image",
	}, lookup)
	if err != nil {
		t.Fatalf("SelectTaskModel() error = %v", err)
	}
	options, ok := result.Input["capabilityOptions"].(map[string]any)
	if !ok {
		t.Fatalf("capabilityOptions = %#v, want object", result.Input["capabilityOptions"])
	}
	if _, exists := options["quality"]; exists {
		t.Fatalf("stale unsupported quality must not enter capabilityOptions: %#v", options)
	}
}

func TestSelectTaskModelRejectsUnsupportedRequest(t *testing.T) {
	channel, channelModel, lookup := imageSelectionLookup(t)
	tests := []struct {
		name  string
		input map[string]any
	}{
		{
			name: "too many reference images",
			input: map[string]any{
				"mode": "image", "referenceImages": []any{"a", "b"},
				"config": map[string]any{"channelId": channel.ID, "model": channelModel.ModelKey},
			},
		},
		{
			name: "unsupported quality",
			input: map[string]any{
				"mode": "image", "config": map[string]any{"channelId": channel.ID, "model": channelModel.ModelKey},
				"capabilityOptions": map[string]any{"quality": "4k", "size": "1:1"},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := SelectTaskModel(TaskSelectRequest{Input: test.input, Type: "canvas_image"}, lookup)
			assertModelError(t, err, ErrCodeModelCapabilityNotSupported, "所选模型不支持当前请求")
		})
	}
}

func TestSelectTaskModelRejectsCorruptCapabilityConfig(t *testing.T) {
	channel, channelModel, lookup := imageSelectionLookup(t)
	channelModel.CapabilityConfigJSON = "{"
	_, err := SelectTaskModel(TaskSelectRequest{
		Input: map[string]any{
			"mode":   "image",
			"config": map[string]any{"channelId": channel.ID, "model": channelModel.ModelKey},
		},
		Type: "canvas_image",
	}, lookup)
	assertModelError(t, err, ErrCodeInvalidModelSelection, "指定的模型能力配置无效，请联系管理员")
}

func TestSelectTaskModelImageResolutionPricing(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGeminiImage), "gemini-image-model")
	profile.Image.Quality = ImageQualityConfig{Supported: false, Default: "auto"}
	profile.Image.Size = ImageSizeConfig{
		Parameter: "aspect_ratio",
		Values:    []string{"1:1", "16:9"},
		Default:   "1:1",
		Presets: []ImageSizePreset{
			{Tier: "1k", Ratio: "16:9", Size: "1824x1024", Width: 1824, Height: 1024},
			{Tier: "2k", Ratio: "16:9", Size: "2752x1536", Width: 2752, Height: 1536},
			{Tier: "4k", Ratio: "16:9", Size: "3840x2160", Width: 3840, Height: 2160},
		},
	}
	channel, channelModel, lookup := selectionLookup(t, "image", model.ChannelInterfaceGeminiImage, profile, []model.ChannelModelVariant{
		{ID: "tier-1k", SelectorKey: `{"quality":"1k"}`, SelectorJSON: `{"quality":"1k"}`, ProviderModelKey: "provider-1k", Enabled: true},
		{ID: "tier-2k", SelectorKey: `{"quality":"2k"}`, SelectorJSON: `{"quality":"2k"}`, ProviderModelKey: "provider-2k", Enabled: true},
		{ID: "tier-4k", SelectorKey: `{"quality":"4k"}`, SelectorJSON: `{"quality":"4k"}`, ProviderModelKey: "provider-4k", Enabled: true},
	})
	for _, tc := range []struct {
		name     string
		quality  string
		size     string
		wantTier string
	}{
		{"1k specified", "1k", "16:9", "tier-1k"},
		{"2k specified", "2k", "16:9", "tier-2k"},
		{"4k specified", "4k", "16:9", "tier-4k"},
		{"auto specified", "auto", "16:9", "tier-1k"},
		{"empty specified", "", "16:9", "tier-1k"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := SelectTaskModel(TaskSelectRequest{
				Input: map[string]any{
					"mode": "image",
					"config": map[string]any{
						"channelId": channel.ID,
						"model":     channelModel.ModelKey,
						"size":      tc.size,
						"quality":   tc.quality,
					},
				},
				Type: "canvas_image",
			}, lookup)
			if err != nil {
				t.Fatalf("SelectTaskModel() error = %v", err)
			}
			cfg := result.Input["config"].(map[string]any)
			if cfg["variantId"] != tc.wantTier {
				t.Fatalf("variantId = %#v, want %s", cfg["variantId"], tc.wantTier)
			}
		})
	}
}

func TestSelectTaskModelUsesRenamedUpstreamKey(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "deepseek-v4.1-flash")
	channel, channelModel, lookup := selectionLookup(t, "text", model.ChannelInterfaceChatCompletion, profile, []model.ChannelModelVariant{
		{ID: "tier-default", SelectorKey: `{}`, SelectorJSON: `{}`, ProviderModelKey: "deepseek-v4.1-flash", Enabled: true},
	})
	channelModel.ModelKey = "deepseek-v4.1-flash"
	channelModel.ProviderModelKey = "deepseek-v4.1-flash"
	result, err := SelectTaskModel(TaskSelectRequest{
		Input: map[string]any{
			"config": map[string]any{"channelId": channel.ID, "model": "deepseek-v4.1-flash", "channelModelKey": "deepseek-v4.1-flash"},
		},
		Type: "canvas_text",
	}, lookup)
	if err != nil {
		t.Fatalf("SelectTaskModel() error = %v", err)
	}
	config := result.Input["config"].(map[string]any)
	if config["providerModelKey"] != "deepseek-v4.1-flash" {
		t.Fatalf("providerModelKey = %v, want deepseek-v4.1-flash", config["providerModelKey"])
	}
}

func TestHasExecutableVideoConfig(t *testing.T) {
	if HasExecutableVideoConfig(map[string]any{"mode": "image", "config": map[string]any{"model": "x", "channelId": "c"}}) {
		t.Fatal("image mode is not an executable video config")
	}
	if !HasExecutableVideoConfig(map[string]any{"mode": "video", "config": map[string]any{"model": "x", "channelId": "c"}}) {
		t.Fatal("system channel video config must be executable")
	}
	if !HasExecutableVideoConfig(map[string]any{"mode": "video", "config": map[string]any{
		"interfaceType": "runninghub-workflow-video", "workflowId": "wf", "baseUrl": "https://rh.example", "apiKey": "k",
	}}) {
		t.Fatal("workflow video config with credentials must be executable")
	}
	if HasExecutableVideoConfig(map[string]any{"mode": "video", "config": map[string]any{
		"interfaceType": "runninghub-workflow-video", "workflowId": "wf",
	}}) {
		t.Fatal("workflow video config without credentials must not be executable")
	}
}

func TestChannelAPIFormatForProtocol(t *testing.T) {
	if got := ChannelAPIFormatForProtocol("legacy", model.ChannelInterfaceGeminiImage); got != "gemini" {
		t.Fatalf("gemini protocol = %q", got)
	}
	if got := ChannelAPIFormatForProtocol("legacy", model.ChannelInterfaceClaudeAPI); got != "claude" {
		t.Fatalf("claude protocol = %q", got)
	}
	if got := ChannelAPIFormatForProtocol("legacy", model.ChannelInterfaceGrokImage); got != "openai" {
		t.Fatalf("default protocol = %q", got)
	}
	if got := ChannelAPIFormatForProtocol("legacy", ""); got != "legacy" {
		t.Fatalf("empty protocol falls back to channel default = %q", got)
	}
}

func TestNewCatalogResponseExclusiveSources(t *testing.T) {
	frontend := NewCatalogResponse(CatalogSourceFrontend, nil, []PublicChannelCatalog{{ID: "should-not-leak"}})
	if frontend.Source != CatalogSourceFrontend || frontend.Models == nil || frontend.Channels == nil {
		t.Fatalf("frontend response missing always-array contract: %#v", frontend)
	}
	if len(frontend.Channels) != 0 {
		t.Fatalf("frontend source leaked channels: %#v", frontend.Channels)
	}
	encoded, err := json.Marshal(frontend)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"models":[]`) || !strings.Contains(string(encoded), `"channels":[]`) {
		t.Fatalf("empty catalog must serialize arrays: %s", encoded)
	}
	system := NewCatalogResponse(CatalogSourceSystem, []PublicLogicalModel{{ID: "should-not-leak"}}, nil)
	if len(system.Models) != 0 || system.Channels == nil {
		t.Fatalf("system source leaked models: %#v", system)
	}
}

func imageSelectionLookup(t *testing.T) (*model.ModelChannel, *model.ChannelModel, TaskSelectLookup) {
	t.Helper()
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGrokImage), "grok-image")
	return selectionLookup(t, "image", model.ChannelInterfaceGrokImage, profile, []model.ChannelModelVariant{
		{ID: "tier-1k", SelectorKey: `{"operation":"text_to_image","quality":"1k"}`, SelectorJSON: `{"operation":"text_to_image","quality":"1k"}`, ProviderModelKey: "provider-image-1k", Enabled: true},
		{ID: "tier-2k", SelectorKey: `{"operation":"text_to_image","quality":"2k"}`, SelectorJSON: `{"operation":"text_to_image","quality":"2k"}`, ProviderModelKey: "provider-image-2k", Enabled: true},
	})
}

func TestSystemSelectionSerializesTypedCapabilityOptions(t *testing.T) {
	channel, selectedModel, lookup := imageSelectionLookup(t)
	result, err := SelectTaskModel(TaskSelectRequest{Type: "canvas_image", Input: map[string]any{
		"mode": "image", "config": map[string]any{"channelId": channel.ID, "model": selectedModel.ModelKey},
		"capabilityOptions": map[string]any{"transparentBackground": false, "count": 1},
	}}, lookup)
	if err != nil {
		t.Fatal(err)
	}
	config := result.Input["config"].(map[string]any)
	if config["transparentBackground"] != "false" || config["count"] != "1" {
		t.Fatalf("non-executable options: %#v", config)
	}
}

func selectionLookup(t *testing.T, capability string, protocol model.ChannelInterfaceType, profile *ModelCapabilityConfig, tiers []model.ChannelModelVariant) (*model.ModelChannel, *model.ChannelModel, TaskSelectLookup) {
	t.Helper()
	raw, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	channel := &model.ModelChannel{ID: "channel-1", Scope: model.ChannelScopeSystem, Enabled: true, Name: "System Channel", APIFormat: "legacy"}
	channelModel := &model.ChannelModel{
		ID: "cm-1", ChannelID: channel.ID, ModelKey: capability + "-model", ProviderModelKey: "provider-default",
		Capability: capability, Protocol: protocol, Enabled: true, CapabilityConfigJSON: string(raw),
		Variants: tiers,
	}
	lookup := TaskSelectLookup{
		SystemChannel: func(id string) (*model.ModelChannel, error) {
			if id != channel.ID {
				return nil, errors.New("missing channel")
			}
			return channel, nil
		},
		ChannelModelByKey: func(channelID, modelKey string) (*model.ChannelModel, error) {
			if channelID != channel.ID || modelKey != channelModel.ModelKey {
				return nil, errors.New("missing model")
			}
			return channelModel, nil
		},
	}
	return channel, channelModel, lookup
}

func assertModelError(t *testing.T, err error, code ModelErrorCode, contains string) {
	t.Helper()
	if err == nil {
		t.Fatal("error = nil")
	}
	var modelErr *ModelError
	if !errors.As(err, &modelErr) {
		t.Fatalf("error type = %T (%v), want *ModelError", err, err)
	}
	if modelErr.ErrorCode != code {
		t.Fatalf("ErrorCode = %q, want %q (err=%v)", modelErr.ErrorCode, code, err)
	}
	if modelErr.AppError == nil || kernel.ErrorReason(modelErr.Reason) != kernel.ErrorReason(code) {
		t.Fatalf("Reason = %q, want %q", modelErr.Reason, code)
	}
	if contains != "" && !strings.Contains(err.Error(), contains) {
		t.Fatalf("error = %q, want substring %q", err.Error(), contains)
	}
}
