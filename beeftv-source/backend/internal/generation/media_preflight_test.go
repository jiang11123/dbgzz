package generation

import (
	"context"
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/kernel"
)

func TestMediaTransportUsesSelectedContractBeforeReadingFiles(t *testing.T) {
	ctx := WithProtocolRegistry(context.Background(), LoadOfficialFallbackRegistry())
	for _, tc := range []struct {
		name, protocol, model, host string
		media                       Media
		blocked                     bool
	}{
		{"URL only local", "newapi-channel-2", "seedance_v2.5", "https://custom.example", Media{StorageKey: "resource:local"}, true},
		{"URL only inline", "newapi-channel-2", "seedance_v2.5", "https://custom.example", Media{DataURL: "data:image/png;base64,YQ=="}, true},
		{"URL only blob", "newapi-channel-2", "seedance_v2.5", "https://custom.example", Media{URL: "blob:local"}, true},
		{"URL only HTTPS", "newapi-channel-2", "seedance_v2.5", "https://custom.example", Media{URL: "https://cdn.example/image.png"}, false},
		{"full video upload", "full-video", "seedance-2.5", "https://custom.example", Media{StorageKey: "resource:local"}, false},
		{"inline protocol", "newapi-channel-1", "video", "https://custom.example", Media{StorageKey: "resource:local"}, false},
		{"BeefAPI upload", "newapi", "seedance-2.0-mini", "https://enterprise.beefapi.com", Media{StorageKey: "resource:local"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := Input{Mode: "video", Config: Config{InterfaceType: tc.protocol, Model: tc.model, BaseURL: tc.host}, ReferenceImages: []Media{tc.media}}
			err := ValidateMediaTransport(ctx, input)
			if (err != nil) != tc.blocked {
				t.Fatalf("error = %v", err)
			}
			if err != nil {
				var appErr *kernel.AppError
				if !errors.As(err, &appErr) || appErr.Reason != "reference_media_requires_url" || !strings.Contains(err.Error(), "参考图片 1") {
					t.Fatalf("unactionable: %v", err)
				}
				classified := ClassifyError(err)
				if classified.Category != CategoryInvalidParams || !strings.Contains(classified.UserMessage(), "参考图片 1") {
					t.Fatalf("lost detail: %#v", classified)
				}
			}
		})
	}
}

func TestBytePlusRejectsOnlyLocalVideoBeforeHydration(t *testing.T) {
	input := Input{Mode: "video", Config: Config{InterfaceType: "volcengine-ark-video", BaseURL: "https://ark.ap-southeast.bytepluses.com/api/v3"}, ReferenceImages: []Media{{StorageKey: "resource:image"}}, ReferenceAudios: []Media{{DataURL: "data:audio/wav;base64,YQ=="}}}
	for _, tc := range []struct {
		name    string
		media   Media
		blocked bool
	}{
		{"resource", Media{StorageKey: "resource:private-video"}, true},
		{"inline", Media{DataURL: "data:video/mp4;base64,YQ=="}, true},
		{"inline URL", Media{URL: "data:video/mp4;base64,YQ=="}, true},
		{"blob", Media{URL: "blob:local"}, true},
		{"HTTPS", Media{URL: "https://cdn.example/video.mp4?signature=test"}, false},
		{"asset", Media{URL: "asset://asset-test"}, false},
		{"embedded credentials", Media{URL: "https://user:secret@cdn.example/video.mp4"}, true},
		{"stale remote on resource", Media{StorageKey: "resource:private-video", URL: "https://cdn.example/video.mp4"}, true},
		{"URL takes precedence", Media{URL: "https://cdn.example/video.mp4", DataURL: "data:video/mp4;base64,YQ=="}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input.ReferenceVideos = []Media{tc.media}
			err := ValidateMediaTransport(context.Background(), input)
			if (err != nil) != tc.blocked {
				t.Fatalf("error = %v", err)
			}
			if err != nil {
				var appErr *kernel.AppError
				if !errors.As(err, &appErr) || appErr.Reason != "reference_media_requires_url" || !strings.Contains(err.Error(), "参考视频 1") || strings.Contains(err.Error(), "private-video") || strings.Contains(err.Error(), "secret") {
					t.Fatalf("unactionable or leaked error: %v", err)
				}
			}
		})
	}
	input.ReferenceVideos = nil
	if err := ValidateMediaTransport(context.Background(), input); err != nil {
		t.Fatalf("local image/audio blocked: %v", err)
	}
	input.ReferenceVideos = []Media{{StorageKey: "resource:video"}}
	for _, host := range []string{"https://ark.cn-beijing.volces.com/api/v3", "https://other.example/api/v3", "https://ark.ap-southeast.bytepluses.com.example/api/v3"} {
		input.Config.BaseURL = host
		if err := ValidateMediaTransport(context.Background(), input); err != nil {
			t.Fatalf("changed other host %s: %v", host, err)
		}
	}
}

func TestMediaTransportNamesOnlyBlockedReferences(t *testing.T) {
	input := Input{Config: Config{InterfaceType: "newapi-channel-2"}, ReferenceImages: []Media{{URL: "https://cdn.example/ok.png"}, {StorageKey: "resource:private-secret"}}, ReferenceVideos: []Media{{StorageKey: "resource:video"}}, ReferenceAudios: []Media{{URL: "data:audio/mp3;base64,YQ=="}}}
	err := ValidateMediaTransport(context.Background(), input)
	if err == nil {
		t.Fatal("accepted local references")
	}
	for _, label := range []string{"参考图片 2", "参考视频 1", "参考音频 1"} {
		if !strings.Contains(err.Error(), label) {
			t.Fatal(err)
		}
	}
	if strings.Contains(err.Error(), "参考图片 1") || strings.Contains(err.Error(), "private-secret") {
		t.Fatal(err)
	}
	input.ReferenceImages = nil
	input.ReferenceVideos = nil
	input.ReferenceAudios = nil
	if err := ValidateMediaTransport(context.Background(), input); err != nil {
		t.Fatal(err)
	}
}

func TestMaskOnlyDisablesURLTransportForImageEditing(t *testing.T) {
	input := Input{Mode: "video", Config: Config{InterfaceType: "newapi-channel-2"}, Mask: &Media{StorageKey: "resource:mask"}}
	if err := ValidateMediaTransport(context.Background(), input); err == nil || !strings.Contains(err.Error(), "遮罩") {
		t.Fatalf("video mask bypassed admission: %v", err)
	}
	input.Mode = "image"
	if MediaHydrationPolicyFor(context.Background(), input).RequireURL {
		t.Fatal("image mask must retain byte transport for multipart editing")
	}
}

func TestMediaTransportAppliesExplicitChoicesPerKind(t *testing.T) {
	input := Input{Mode: "video", Config: Config{InterfaceType: "newapi-channel-2", ReferenceMediaTransport: map[string]string{"image": "inline", "video": "url", "audio": "link"}}, ReferenceImages: []Media{{StorageKey: "resource:private-image"}}, ReferenceVideos: []Media{{StorageKey: "resource:private-video"}}, ReferenceAudios: []Media{{URL: "https://cdn.example/audio.mp3"}}}
	err := ValidateMediaTransport(context.Background(), input)
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || strings.Contains(err.Error(), "参考图片") || !strings.Contains(err.Error(), "参考视频 1") {
		t.Fatalf("wrong references blocked: %v", err)
	}
	required := appErr.Details["requiredReferences"].([]map[string]any)
	if len(required) != 1 || required[0]["kind"] != "video" || required[0]["index"] != 0 {
		t.Fatal(required)
	}
	input.ReferenceVideos[0] = Media{URL: "https://cdn.example/video.mp4"}
	if err := ValidateMediaTransport(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	input.Config.ChannelID = "managed"
	if err := ValidateMediaTransport(context.Background(), input); err == nil {
		t.Fatal("custom choice overrode managed channel policy")
	}
	input.Config.ReferenceMediaTransport["image"] = "guess"
	if err := ValidateMediaTransport(context.Background(), input); err == nil {
		t.Fatal("invalid transport accepted")
	}
}

func TestDashScopeWanHydratesLocalImagesButRequiresOnlineAudio(t *testing.T) {
	var events []string
	ctx := WithProtocolRegistry(WithRuntime(context.Background(), Runtime{Resources: stageResources{events: &events}}), LoadOfficialFallbackRegistry())
	input := Input{Mode: "video", Config: Config{InterfaceType: "dashscope-wan-video"}, ReferenceImages: []Media{{StorageKey: "resource:one"}}, ReferenceAudios: []Media{{URL: "https://cdn.example/audio.mp3"}}}
	if err := ValidateMediaTransport(ctx, input); err != nil {
		t.Fatal(err)
	}
	if err := HydrateMedia(ctx, "owner", &input, MediaHydrationPolicyFor(ctx, input)); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(input.ReferenceImages[0].DataURL, "data:image/png;base64,") {
		t.Fatal("local image did not become inline input")
	}
	if input.ReferenceAudios[0].URL != "https://cdn.example/audio.mp3" {
		t.Fatal("online audio changed")
	}
	input.ReferenceAudios[0] = Media{StorageKey: "resource:audio"}
	if err := ValidateMediaTransport(ctx, input); err == nil || !strings.Contains(err.Error(), "参考音频") {
		t.Fatalf("local audio escaped URL contract: %v", err)
	}
}

type referenceStorageFixture struct {
	uploads int
	failure error
}

func (p *referenceStorageFixture) Enabled() (bool, error) { return true, nil }
func (p *referenceStorageFixture) Upload(ctx context.Context, userID, resourceID string) (string, error) {
	p.uploads++
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if p.failure != nil {
		return "", p.failure
	}
	if userID != "owner" || resourceID != "one" {
		return "", errors.New("unexpected owned reference")
	}
	return "https://cdn.example/uploaded.png", nil
}

func TestReferenceStorageRunsOnlyDuringExecutionAndHonorsManualLinks(t *testing.T) {
	for _, protocol := range []string{"newapi-channel-2", "volcengine-ark-video"} {
		var events []string
		storage := &referenceStorageFixture{}
		ctx := WithRuntime(context.Background(), Runtime{Resources: stageResources{events: &events}, ReferenceStorage: storage})
		input := Input{Mode: "video", Config: Config{InterfaceType: protocol, BaseURL: "https://ark.ap-southeast.bytepluses.com/api/v3"}, ReferenceVideos: []Media{{StorageKey: "resource:one"}}}
		if err := ValidateMediaTransport(ctx, input); err != nil {
			t.Fatal(err)
		}
		if storage.uploads != 0 || len(events) != 0 {
			t.Fatal("admission read/uploaded reference bytes")
		}
		if err := HydrateMedia(ctx, "owner", &input, MediaHydrationPolicyFor(ctx, input)); err != nil {
			t.Fatal(err)
		}
		if storage.uploads != 1 || input.ReferenceVideos[0].URL != "https://cdn.example/uploaded.png" {
			t.Fatal("runtime upload did not supply the URL")
		}
		input.Config.ReferenceMediaTransport = map[string]string{"video": "link"}
		if err := ValidateMediaTransport(ctx, input); err == nil {
			t.Fatal("manual mode silently uploaded owned reference")
		}
		input.Config.ReferenceMediaTransport = nil
		storage.failure = errors.New("HTTP 403 upload denied")
		if err := HydrateMedia(ctx, "owner", &input, MediaHydrationPolicyFor(ctx, input)); err == nil || !strings.Contains(err.Error(), "参考视频 1") || !strings.Contains(err.Error(), "403") {
			t.Fatalf("missing per-asset upload error: %v", err)
		}
	}
}

func TestBytePlusExplicitInlineVideoNeverPassesWithStorageEnabled(t *testing.T) {
	storage := &referenceStorageFixture{}
	ctx := WithRuntime(context.Background(), Runtime{ReferenceStorage: storage})
	input := Input{Mode: "video", Config: Config{InterfaceType: "volcengine-ark-video", BaseURL: "https://ark.ap-southeast.bytepluses.com/api/v3", ReferenceMediaTransport: map[string]string{"video": "inline"}}, ReferenceVideos: []Media{{StorageKey: "resource:one"}}}
	var appErr *kernel.AppError
	if err := ValidateMediaTransport(ctx, input); !errors.As(err, &appErr) || appErr.Reason != "invalid_reference_transport" {
		t.Fatalf("inline BytePlus video admitted: %v", err)
	}
	if !mediaPolicyForKind(ctx, input, "video", MediaHydrationPolicyFor(ctx, input)).RequireURL || storage.uploads != 0 {
		t.Fatal("BytePlus video policy no longer requires a URL")
	}
}

func TestWanInlineImageNeverUploadsEvenWhenStorageIsEnabled(t *testing.T) {
	var events []string
	storage := &referenceStorageFixture{}
	ctx := WithProtocolRegistry(WithRuntime(context.Background(), Runtime{ReferenceStorage: storage, Resources: stageResources{events: &events}}), LoadOfficialFallbackRegistry())
	input := Input{Mode: "video", Config: Config{InterfaceType: "dashscope-wan-video", ReferenceMediaTransport: map[string]string{"image": "inline"}}, ReferenceImages: []Media{{StorageKey: "resource:one"}}}
	if err := ValidateMediaTransport(ctx, input); err != nil {
		t.Fatal(err)
	}
	if err := HydrateMedia(ctx, "owner", &input, MediaHydrationPolicyFor(ctx, input)); err != nil {
		t.Fatal(err)
	}
	if storage.uploads != 0 || !strings.HasPrefix(input.ReferenceImages[0].DataURL, "data:image/png;base64,") {
		t.Fatal("inline image was uploaded instead")
	}
}
