package app

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestWanLocalReferencesRemainOwnedForHTTPUpload(t *testing.T) {
	input := canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: "https://enterprise.beefapi.com", InterfaceType: "newapi-channel-2", Model: "wan3.0-video"}, ReferenceImages: []providerMedia{{DataURL: testGeminiReferenceImageDataURL}}}
	policy := providerMediaHydrationPolicyFor(context.Background(), input)
	if policy.RequireURL || !policy.KeepLocal {
		t.Fatalf("Wan local media blocked: %#v", policy)
	}
	svc := newResourceTestService(t)
	svc.mode = serviceModeLocal
	svc.localResourceStorage = true
	png, err := base64.StdEncoding.DecodeString(strings.SplitN(testGeminiReferenceImageDataURL, ",", 2)[1])
	if err != nil {
		t.Fatal(err)
	}
	key := "users/user-1/image/wan-reference.png"
	path := filepath.Join(svc.dataDir, "resources", key)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, png, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.CreateResource(&model.Resource{ID: "wan-reference", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: key, MimeType: "image/png", Size: int64(len(png))}); err != nil {
		t.Fatal(err)
	}
	input.ReferenceImages = []providerMedia{{StorageKey: "resource:wan-reference"}}
	if err := svc.hydrateGenerationMedia("user-1", &input, policy); err != nil {
		t.Fatal(err)
	}
	// The provider uploader reads owned bytes next; hydration must not turn
	// this local reference into an inline value rejected by Wan's HTTP contract.
	if media := input.ReferenceImages[0]; media.StorageKey != "resource:wan-reference" || media.DataURL != "" {
		t.Fatalf("local reference changed before upload: %#v", media)
	}
	foreign := canvasGenerationInput{ReferenceImages: []providerMedia{{StorageKey: "resource:wan-reference"}}}
	if err := svc.hydrateGenerationMedia("another-user", &foreign, policy); err == nil {
		t.Fatal("foreign media accepted")
	}
	input.ReferenceVideos = []providerMedia{{URL: "https://example.com/ref.mp4"}}
	if err := svc.validateResolvedVideoCapability(&input); err == nil || !strings.Contains(err.Error(), "暂不支持参考视频") {
		t.Fatalf("unsupported media silently accepted: %v", err)
	}
	input.Config.Model = "wan4.0-video"
	if !providerMediaHydrationPolicyFor(context.Background(), input).RequireURL {
		t.Fatal("unknown model inherited built-in upload support")
	}
	input.Config.Model = "wan3.0-video"
	input.Config.BaseURL = "https://another.example/enterprise.beefapi.com"
	if !providerMediaHydrationPolicyFor(context.Background(), input).RequireURL {
		t.Fatal("untrusted endpoint inherited built-in upload support")
	}
}

func TestInstalledMediaContractOverridesLegacyGuess(t *testing.T) {
	ctx := withProtocolRegistry(context.Background(), loadOfficialFallbackRegistry())
	for _, protocol := range []string{"grok-image", "chat-completion", "openai-response", "claude-api"} {
		policy := providerMediaHydrationPolicyFor(ctx, canvasGenerationInput{Config: providerConfig{InterfaceType: protocol}})
		if policy.RequireURL || !policy.PreferURL {
			t.Fatalf("%s lost optional object-storage URL transport: %#v", protocol, policy)
		}
	}
	inline := providerMediaHydrationPolicyFor(ctx, canvasGenerationInput{Config: providerConfig{InterfaceType: "newapi", Model: "future-model"}})
	if inline.RequireURL {
		t.Fatal("installed multipart contract ignored")
	}
	remote := providerMediaHydrationPolicyFor(ctx, canvasGenerationInput{Config: providerConfig{InterfaceType: "newapi-channel-2", Model: "future-model"}})
	if !remote.RequireURL {
		t.Fatal("URL-only contract ignored")
	}
}

func TestSavedBeefAPISeedanceAudioControl(t *testing.T) {
	for _, channelID := range []string{"", "saved-channel"} {
		for _, baseURL := range []string{"https://enterprise.beefapi.com", "https://custom.example"} {
			t.Run(channelID+baseURL, func(t *testing.T) {
				svc, db, _, _ := creationTestService(t)
				profile := DefaultModelCapabilityConfigForModel("newapi", "seedance-2.0-fast")
				profile.Video.GenerateAudio.Supported = false
				profile.Video.GenerateAudio.Default = false
				profile.Video.References.MaxImages = 2
				if channelID != "" {
					if err := db.Create(&model.ChannelModel{ID: "saved-video", ChannelID: channelID, ModelKey: "seedance-2.0-fast", Capability: "video", Protocol: model.ChannelInterfaceNewAPIVideo, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, profile), Enabled: true}).Error; err != nil {
						t.Fatal(err)
					}
				}
				input := canvasGenerationInput{Mode: "video", Prompt: "forest", Config: providerConfig{BaseURL: baseURL, ChannelID: channelID, Model: "seedance-2.0-fast", InterfaceType: "newapi", CapabilityConfig: profile, VideoSeconds: "5", VQuality: "480p", Size: "16:9", VideoGenerateAudio: "false"}}
				if err := svc.validateResolvedVideoCapability(&input); err != nil {
					t.Fatal(err)
				}
				if input.VideoCapability.GenerateAudio.Supported != isBeefAPIVideoConfig(context.Background(), input.Config) || input.VideoCapability.GenerateAudio.Default || input.VideoCapability.References.MaxImages != 2 {
					t.Fatalf("unexpected profile: %#v", input.VideoCapability)
				}
				if isBeefAPIVideoConfig(context.Background(), input.Config) {
					body, err := beefAPIVideoRequestBody(input)
					if err != nil || body["generate_audio"] != false {
						t.Fatalf("explicit false lost: %#v, %v", body, err)
					}
				}
			})
		}
	}
}
