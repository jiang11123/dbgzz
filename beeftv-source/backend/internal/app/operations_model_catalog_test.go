package app

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/operations"
)

func TestAgentModelCatalogBeefAPIVideoContractAndAudioPayload(t *testing.T) {
	for _, tc := range []struct {
		name, baseURL                     string
		configured, audioDefault, sourced bool
	}{
		{name: "missing profile", baseURL: "https://beeftv.app"},
		{name: "saved false", baseURL: "https://enterprise.beefapi.com/v1", configured: true},
		{name: "saved true", baseURL: "https://enterprise.beefapi.com/v1", configured: true, audioDefault: true},
		{name: "custom endpoint", baseURL: "https://custom.example", configured: true},
		{name: "versioned gateway contract", baseURL: "https://enterprise.beefapi.com/v1", configured: true, sourced: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, _ := newModelCatalogTestService(t)
			svc.mode = serviceModeLocal
			profile := map[string]any{"model": "kling-video-v3", "capability": "video", "protocol": "newapi"}
			if tc.configured {
				config := modelcatalog.DefaultModelCapabilityConfigForModel("newapi", "kling-video-v3")
				config.Video.GenerateAudio.Default = tc.audioDefault
				profile["capabilityConfig"] = config
			}
			if tc.sourced {
				profile["videoCapabilitiesVersion"] = "gateway-v2"
			}
			channelID := "beefapi"
			if tc.name == "custom endpoint" {
				channelID = "custom"
			}
			body, _ := json.Marshal(map[string]any{"channels": []any{map[string]any{"id": channelID, "baseUrl": tc.baseURL, "models": []string{"kling-video-v3"}, "modelProfiles": []any{profile}}}})
			if err := svc.SaveLocalModelConfig(body); err != nil {
				t.Fatal(err)
			}
			registry := operations.NewRegistry(svc, operations.NewStore(svc.repo.DB()))
			operations.RegisterDefaultOps(registry)
			result, err := registry.Execute(operations.Request{Op: "model.catalog", UserID: "desktop-owner", Caller: operations.ManualCaller(true), Params: json.RawMessage(`{"capability":"video"}`)})
			if err != nil {
				t.Fatal(err)
			}
			wire, _ := json.Marshal(result.Result)
			var catalog modelcatalog.CatalogResponse
			if err := json.Unmarshal(wire, &catalog); err != nil {
				t.Fatal(err)
			}
			if len(catalog.Channels) != 1 || len(catalog.Channels[0].Models) != 1 {
				t.Fatalf("catalog=%#v", catalog)
			}
			raw, _ := json.Marshal(catalog.Channels[0].Models[0].CapabilityConfig)
			var config modelcatalog.ModelCapabilityConfig
			if err := json.Unmarshal(raw, &config); err != nil {
				t.Fatal(err)
			}
			video := config.Video
			if video == nil || video.GenerateAudio.Default != tc.audioDefault {
				t.Fatalf("audio choice changed: %#v", video)
			}
			if tc.sourced || tc.name == "custom endpoint" {
				if video.GenerateAudio.Supported || video.Duration.Min != 1 || video.References.MaxImages != 9 {
					t.Fatalf("overwrote independent contract: %#v", video)
				}
				return
			}
			if !video.GenerateAudio.Supported || video.Duration.Min != 3 || video.Duration.Max != 15 || video.Duration.Default != 5 || len(video.Resolutions) != 1 || video.Resolutions[0] != "720p" || len(video.Ratios) != 3 || video.References.MaxImages != 1 || video.References.MaxVideos != 0 || video.References.MaxAudios != 0 {
				t.Fatalf("does not match generation contract: %#v", video)
			}
			for _, audio := range []bool{video.GenerateAudio.Default, true, false} {
				payload, err := generation.BeefAPIVideoRequestBody(generation.Input{Mode: "video", Prompt: "synthetic scene", Config: generation.Config{Model: "kling-video-v3", VideoSeconds: strconv.Itoa(video.Duration.Default), VQuality: video.DefaultResolution, Size: video.DefaultRatio, VideoGenerateAudio: strconv.FormatBool(audio)}})
				if err != nil {
					t.Fatal(err)
				}
				if payload["generate_audio"] != audio {
					t.Fatalf("lost selected audio=%v: %#v", audio, payload)
				}
			}
		})
	}
}

func TestAgentModelCatalogDesktopUsesActualSnapshotWithoutCredentials(t *testing.T) {
	svc, _ := newModelCatalogTestService(t)
	svc.mode = serviceModeLocal
	body := []byte(`{"channels":[{"id":"beefapi","name":"BeefTV","credentialRef":"beefapi-enterprise","apiKey":"private-key","baseUrl":"https://private-provider.test/v1","headers":[{"name":"Authorization","value":"private-header"}],"enabled":true,"models":["gemini-native","image-model"],"modelProfiles":[{"model":"gemini-native","displayName":"Native Gemini","capability":"text","protocol":"chat-completion"},{"model":"image-model","displayName":"Reference Image","capability":"image","protocol":"openai-image"}]},{"id":"disabled","enabled":false,"models":["hidden"]}]}`)
	if err := svc.SaveLocalModelConfig(body); err != nil {
		t.Fatal(err)
	}
	catalog, err := (&operationSession{service: svc}).AgentModelCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if catalog.Source != modelcatalog.CatalogSourceSystem || len(catalog.Models) != 0 || len(catalog.Channels) != 1 {
		t.Fatalf("catalog=%#v", catalog)
	}
	ch := catalog.Channels[0]
	if ch.ID != "beefapi" || ch.Name != "BeefTV" || len(ch.Models) != 2 || ch.Models[0].ModelKey != "gemini-native" || !ch.Models[0].Available || ch.Models[1].Capability != "image" {
		t.Fatalf("channel=%#v", ch)
	}
	registry := operations.NewRegistry(svc, operations.NewStore(svc.repo.DB()))
	operations.RegisterDefaultOps(registry)
	result, err := registry.Execute(operations.Request{Op: "model.catalog", UserID: "desktop-owner", Caller: operations.ManualCaller(true), Params: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	var operationCatalog modelcatalog.CatalogResponse
	wire, err := json.Marshal(result.Result)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(wire, &operationCatalog); err != nil {
		t.Fatal(err)
	}
	if len(operationCatalog.Channels) != 1 || len(operationCatalog.Channels[0].Models) != 2 {
		t.Fatalf("shared operation result: %#v", result.Result)
	}
	encoded, _ := json.Marshal(catalog)
	for _, secret := range []string{"private-key", "private-header", "private-provider", "baseUrl", "credentialRef", "apiKey"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("leaked %s: %s", secret, encoded)
		}
	}
	if err := svc.SaveLocalModelConfig([]byte(`{"channels":[]}`)); err != nil {
		t.Fatal(err)
	}
	refreshed, err := (&operationSession{service: svc}).AgentModelCatalog()
	if err != nil || len(refreshed.Channels) != 0 {
		t.Fatalf("refresh=%#v %v", refreshed, err)
	}
}
func TestAgentModelCatalogHostedIgnoresDesktopSnapshot(t *testing.T) {
	svc, db := newModelCatalogTestService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"channels":[{"id":"private","models":["private-model"]}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.SystemSetting{Key: featureAvailabilitySettingKey, ValueJSON: `{"frontendModelsEnabled":true}`}).Error; err != nil {
		t.Fatal(err)
	}
	catalog, err := (&operationSession{service: svc}).AgentModelCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if catalog.Source != modelcatalog.CatalogSourceFrontend || len(catalog.Channels) != 0 || len(catalog.Models) != 0 {
		t.Fatalf("hosted=%#v", catalog)
	}
}

// Profiles here are the desktop persisted contract, including gateway capability
// overrides; catalog projection must preserve them rather than substitute defaults.
func TestAgentModelCatalogPreservesDesktopGenerationProfiles(t *testing.T) {
	svc, _ := newModelCatalogTestService(t)
	svc.mode = serviceModeLocal
	video := modelcatalog.DefaultModelCapabilityConfigForModel("new-api-channel-2", "seedance-2.0-fast")
	video.Video.Resolutions = []string{"480p", "720p"}
	video.Video.DefaultResolution = "480p"
	video.Video.Duration = modelcatalog.VideoDurationConfig{Selection: "enum", Values: []int{5, 10}, Default: 5}
	video.Video.References.MaxImages = 9
	video.Video.References.MaxVideos = 3
	image := modelcatalog.DefaultModelCapabilityConfigForModel("openai-image", "gpt-image-2.5")
	image.Image.References.MaxImages = 7
	profile := func(name, kind, protocol string, config any) map[string]any {
		return map[string]any{"model": name, "displayName": name, "capability": kind, "protocol": protocol, "capabilityConfig": config}
	}
	body, err := json.Marshal(map[string]any{"channels": []any{map[string]any{"id": "beefapi", "name": "BeefTV", "enabled": true, "models": []string{"seedance-2.0-fast", "gpt-image-2.5"}, "modelProfiles": []any{profile("seedance-2.0-fast", "video", "new-api-channel-2", video), profile("gpt-image-2.5", "image", "openai-image", image)}}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SaveLocalModelConfig(body); err != nil {
		t.Fatal(err)
	}
	catalog, err := (&operationSession{service: svc}).AgentModelCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Channels) != 1 || len(catalog.Channels[0].Models) != 2 {
		t.Fatalf("catalog=%#v", catalog)
	}
	var gotVideo, gotImage modelcatalog.ModelCapabilityConfig
	raw, _ := json.Marshal(catalog.Channels[0].Models[0].CapabilityConfig)
	if err := json.Unmarshal(raw, &gotVideo); err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(catalog.Channels[0].Models[1].CapabilityConfig)
	if err := json.Unmarshal(raw, &gotImage); err != nil {
		t.Fatal(err)
	}
	if gotVideo.Video == nil || gotVideo.Video.DefaultResolution != "480p" || gotVideo.Video.Duration.Default != 5 || gotVideo.Video.References.MaxImages != 9 || gotVideo.Video.References.MaxVideos != 3 {
		t.Fatalf("lost desktop video contract: %#v", gotVideo.Video)
	}
	if gotImage.Image == nil || gotImage.Image.References.MaxImages != 7 || gotImage.Image.Size.Default != image.Image.Size.Default {
		t.Fatalf("lost desktop image contract: %#v", gotImage.Image)
	}
}

func TestAgentCatalogFiltersCapabilityAndExposesOnlyValidatedQuote(t *testing.T) {
	svc, _ := newModelCatalogTestService(t)
	svc.mode = serviceModeLocal
	body := []byte(`{"channels":[{"id":"beefapi","enabled":true,"models":["text-model","video-model","unknown-price"],"modelProfiles":[{"model":"text-model","capability":"text","protocol":"chat-completion"},{"model":"video-model","capability":"video","protocol":"openai-videos","videoPricing":{"currency":"CNY","mode":"seconds","rates":{"720p":{"output":0.25,"reference_video":0,"apiKey":"private-rate"}},"token":"private-quote"}},{"model":"unknown-price","capability":"video","protocol":"openai-videos","videoPricing":{"currency":"USD","mode":"seconds","rates":{"720p":{"output":1,"reference_video":0}}}}]}]}`)
	if err := svc.SaveLocalModelConfig(body); err != nil {
		t.Fatal(err)
	}
	registry := operations.NewRegistry(svc, operations.NewStore(svc.repo.DB()))
	operations.RegisterDefaultOps(registry)
	read := func(params string) modelcatalog.CatalogResponse {
		t.Helper()
		result, err := registry.Execute(operations.Request{Op: "model.catalog", UserID: "desktop-owner", Caller: operations.ManualCaller(true), Params: json.RawMessage(params)})
		if err != nil {
			t.Fatal(err)
		}
		wire, err := json.Marshal(result.Result)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(wire), "private-") {
			t.Fatalf("quote leaked unknown fields: %s", wire)
		}
		var catalog modelcatalog.CatalogResponse
		if err := json.Unmarshal(wire, &catalog); err != nil {
			t.Fatal(err)
		}
		return catalog
	}
	video := read(`{"capability":"video"}`)
	if len(video.Channels) != 1 || len(video.Channels[0].Models) != 2 {
		t.Fatalf("video catalog: %#v", video)
	}
	models := video.Channels[0].Models
	if models[0].VideoPricing["currency"] != "CNY" || models[1].VideoPricing != nil {
		t.Fatalf("quotes: %#v", models)
	}
	if got := read(`{"capability":"image"}`); len(got.Channels) != 0 || got.Channels == nil || got.Models == nil {
		t.Fatalf("empty catalog: %#v", got)
	}
	if got := read(`{}`); len(got.Channels[0].Models) != 3 {
		t.Fatalf("filter mutated source: %#v", got)
	}
	if _, err := registry.Execute(operations.Request{Op: "model.catalog", UserID: "desktop-owner", Caller: operations.ManualCaller(true), Params: json.RawMessage(`{"capability":"other"}`)}); err == nil {
		t.Fatal("unknown capability accepted")
	}
}
