package app

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestSourcedSeedanceGenerationKeepsServerLimitsAndAudio(t *testing.T) {
	version := "gateway-version"
	profile := DefaultModelCapabilityConfigForModel("newapi", "seedance-2.0")
	profile.Video.References.MaxImages = 12
	profile.Video.GenerateAudio.Supported = false
	input := canvasGenerationInput{Mode: "video", Prompt: "test", Config: providerConfig{InterfaceType: "newapi", BaseURL: "https://enterprise.beefapi.com", Model: "seedance-2.0", VideoSeconds: "5", Size: "16:9", VQuality: "720p", CapabilityConfig: profile, VideoCapabilitiesVersion: &version}}
	for i := 0; i < 10; i++ {
		input.ReferenceImages = append(input.ReferenceImages, providerMedia{URL: "asset://test", Width: 640, Height: 640, Bytes: 10})
	}
	if err := (&Service{}).validateResolvedVideoCapability(&input); err != nil {
		t.Fatal(err)
	}
	if input.VideoCapability.GenerateAudio.Supported {
		t.Fatal("catalog audio false was restored by legacy repair")
	}
	input.Config.VideoCapabilitiesVersion = nil
	restoreBeefAPISeedanceAudioControl(context.Background(), input.Config, input.VideoCapability)
	if !input.VideoCapability.GenerateAudio.Supported {
		t.Fatal("legacy saved profiles should retain the audio repair")
	}
}

func TestNativeArkModelDefaultsAndExplicitRestrictions(t *testing.T) {
	for _, protocol := range []string{"volcengine-ark-video", "volcengine-ark-agent-plan-video"} {
		for _, name := range []string{"seedance-2.5", "doubao-seedance-2-5-260528", "dreamina-seedance-2-5-260628"} {
			profile := DefaultModelCapabilityConfigForModel(protocol, name).Video
			if profile.References.MaxImages != 30 || profile.References.MaxVideos != 10 || profile.References.MaxAudios != 10 || profile.References.MinAudioDuration != 2 || profile.Duration.Max != 30 {
				t.Fatalf("%s %s defaults = %#v", protocol, name, profile)
			}
			input := canvasGenerationInput{Config: providerConfig{InterfaceType: protocol}, ReferenceAudios: []providerMedia{{URL: "asset://voice", DurationMs: 2000}}}
			if err := validateVideoReferenceMedia(profile, input); err != nil {
				t.Fatal(err)
			}
			input.ReferenceAudios[0].DurationMs = 1999
			if err := validateVideoReferenceMedia(profile, input); err == nil {
				t.Fatal("native audio below 2 seconds accepted")
			}
			input.ReferenceAudios[0].DurationMs = 0
			if err := validateVideoReferenceMedia(profile, input); err != nil {
				t.Fatalf("opaque asset rejected: %v", err)
			}
			input.ReferenceAudios[0].URL = "https://example.com/unknown.wav"
			if err := validateVideoReferenceMedia(profile, input); err == nil {
				t.Fatal("unknown URL duration accepted")
			}
			profile.References.MaxAudios = 0
			profile.Operations = []string{"text_to_video"}
			normalized, err := NormalizeModelCapabilityConfigForModel("video", protocol, name, &ModelCapabilityConfig{Version: 1, Video: profile})
			if err != nil || normalized.Video.References.MaxAudios != 0 || videoCapabilityAllowsAudioOnly(normalized.Video) {
				t.Fatalf("explicit restrictions expanded: %#v, %v", normalized, err)
			}
		}
		for _, name := range []string{"seedance-2.0", "doubao-seedance-2-0-260128", "ep-custom-endpoint"} {
			profile := DefaultModelCapabilityConfigForModel(protocol, name).Video
			if videoCapabilityAllowsAudioOnly(profile) {
				t.Fatalf("unknown or 2.0 model %s inferred audio-only", name)
			}
		}
	}
}

func TestDreaminaFastMiniRejectUnsupportedResolution(t *testing.T) {
	for _, name := range []string{"dreamina-seedance-2-0-fast-260128", "dreamina-seedance-2-0-mini-260615"} {
		for _, resolution := range []string{"480p", "720p", "1080p"} {
			profile := DefaultModelCapabilityConfigForModel("volcengine-ark-video", name)
			input := canvasGenerationInput{Mode: "video", Prompt: "test", Config: providerConfig{InterfaceType: "volcengine-ark-video", Model: name, VideoSeconds: "5", Size: "16:9", VQuality: resolution, CapabilityConfig: profile}}
			err := (&Service{}).validateResolvedVideoCapability(&input)
			if (err != nil) != (resolution == "1080p") {
				t.Fatalf("%s %s validation = %v", name, resolution, err)
			}
		}
	}
}

func TestDreaminaOperationsValidateAndReachOfficialWireContract(t *testing.T) {
	for _, operation := range []string{"inpaint", "extend", "reference_to_video"} {
		input := canvasGenerationInput{Mode: "video", Prompt: "change the light", Config: providerConfig{InterfaceType: "volcengine-ark-video", Model: "dreamina-seedance-2-5-260628", VideoSeconds: "6", Size: "16:9", VQuality: "480p"}, Metadata: map[string]interface{}{"videoEditOperation": operation}, ReferenceVideos: []providerMedia{{URL: "https://cdn.example/video.mp4", Width: 864, Height: 496, DurationMs: 4000}}}
		if err := (&Service{}).validateResolvedVideoCapability(&input); err != nil {
			t.Fatalf("%s validation: %v", operation, err)
		}
		body := officialVideoCreateBody(t, input)
		wantType, wantRatio, wantDuration := "reference", "16:9", float64(6)
		if operation == "inpaint" {
			wantType, wantRatio, wantDuration = "edit", "adaptive", -1
		}
		if operation == "extend" {
			wantType, wantRatio = "extend", "adaptive"
		}
		if body["omni_reference_task_type"] != wantType || body["ratio"] != wantRatio || body["duration"] != wantDuration {
			t.Fatalf("%s body: %#v", operation, body)
		}
		input.ReferenceVideos[0].DurationMs = 3999
		err := (&Service{}).validateResolvedVideoCapability(&input)
		if (err != nil) != (operation == "inpaint") {
			t.Fatalf("%s 3999ms: %v", operation, err)
		}
		input.ReferenceVideos[0].DurationMs = 4000
		input.Config.CapabilityConfig.Video.Operations = []string{"text_to_video"}
		if err := (&Service{}).validateResolvedVideoCapability(&input); err == nil {
			t.Fatal("explicit profile operations expanded")
		}
	}
}

func TestDreaminaDefaultDurationAndAdaptiveAdmission(t *testing.T) {
	for _, name := range []string{"dreamina-seedance-2-0-260128", "dreamina-seedance-2-0-fast-260128", "dreamina-seedance-2-0-mini-260615", "dreamina-seedance-2-5-260628"} {
		profile := DefaultModelCapabilityConfigForModel("volcengine-ark-video", name).Video
		if profile.Duration.Selection != "enum" || len(profile.Duration.Values) != profile.Duration.Max-2 || profile.Duration.Values[0] != -1 || profile.Duration.Values[1] != 4 || profile.Duration.Values[len(profile.Duration.Values)-1] != profile.Duration.Max {
			t.Fatalf("missing automatic/duration choices: %#v", profile.Duration)
		}
		for _, seconds := range []string{"-1", "1", "3", "4", "15", "30"} {
			input := canvasGenerationInput{Mode: "video", Prompt: "forest", Config: providerConfig{InterfaceType: "volcengine-ark-video", Model: name, VideoSeconds: seconds, Size: "adaptive", VQuality: "480p"}}
			err := (&Service{}).validateResolvedVideoCapability(&input)
			blocked := seconds == "1" || seconds == "3" || (seconds == "30" && !strings.Contains(name, "2-5"))
			if (err != nil) != blocked {
				t.Fatalf("%s %ss: %v", name, seconds, err)
			}
		}
	}
}

func TestCatalogSeedanceLimitsAreNotOverwritten(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi-channel-2", "seedance-2.5").Video
	profile.References.MaxImages = 12
	profile.References.MaxVideos = 4
	profile.References.MaxAudios = 5
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "newapi-channel-2", "seedance-2.5", &ModelCapabilityConfig{Version: 1, Video: profile})
	if err != nil {
		t.Fatalf("NormalizeModelCapabilityConfigForModel() error = %v", err)
	}
	if normalized.Video.References.MaxImages != 12 || normalized.Video.References.MaxVideos != 4 || normalized.Video.References.MaxAudios != 5 {
		t.Fatalf("catalog limits overwritten: %#v", normalized.Video.References)
	}
	if !containsCapabilityString(normalized.Video.Operations, "audio_to_video") {
		t.Fatalf("operations = %v, want audio_to_video kept", normalized.Video.Operations)
	}
}

func TestCatalogSeedanceExplicitZerosArePreserved(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi", "other-video").Video
	profile.References.MaxImages = 0
	profile.References.MaxVideos = 0
	profile.References.MaxAudios = 0
	profile.Operations = []string{"text_to_video", "image_to_video"}
	profile.DefaultOperation = "text_to_video"
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "newapi", "seedance-2.5", &ModelCapabilityConfig{Version: 1, Video: profile})
	if err != nil {
		t.Fatalf("NormalizeModelCapabilityConfigForModel() error = %v", err)
	}
	if normalized.Video.References.MaxImages != 0 || normalized.Video.References.MaxVideos != 0 || normalized.Video.References.MaxAudios != 0 {
		t.Fatalf("explicit zeros overwritten: %#v", normalized.Video.References)
	}
	if containsCapabilityString(normalized.Video.Operations, "audio_to_video") || containsCapabilityString(normalized.Video.Operations, "reference_to_video") {
		t.Fatalf("operations expanded: %v", normalized.Video.Operations)
	}
}

func TestEnterpriseSeedanceMaxImagesNotExpandedToOfficial30(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi-channel-2", "seedance-2.5").Video
	profile.References.MaxImages = 9
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "newapi-channel-2", "seedance-2.5", &ModelCapabilityConfig{Version: 1, Video: profile})
	if err != nil {
		t.Fatalf("NormalizeModelCapabilityConfigForModel() error = %v", err)
	}
	if normalized.Video.References.MaxImages != 9 {
		t.Fatalf("enterprise maxImages expanded: %d", normalized.Video.References.MaxImages)
	}
}

func TestNativeArkSeedanceUsesDocumentedVideoPixelFloor(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("volcengine-ark-video", "seedance-2.0").Video
	if profile.References.MinVideoPixels != officialSeedanceVideoMinPixels {
		t.Fatalf("stored default min pixels = %d", profile.References.MinVideoPixels)
	}
	input := canvasGenerationInput{
		Config:          providerConfig{InterfaceType: "volcengine-ark-video", Model: "seedance-2.0", BaseURL: "https://ark.cn-beijing.volces.com/api/v3"},
		ReferenceVideos: []providerMedia{{Width: 720, Height: 567, DurationMs: 3000, Bytes: 1}},
	}
	if err := validateVideoReferenceMedia(profile, input); err != nil {
		t.Fatalf("720×567 should pass documented 407696 floor: %v", err)
	}
	input.ReferenceVideos[0].Height = 566
	if err := validateVideoReferenceMedia(profile, input); err == nil {
		t.Fatal("720×566 accepted below 407696")
	}
}

func TestCustomSeedancePixelRestrictionIsPreserved(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi", "seedance-2.0").Video
	profile.References.MinVideoPixels = 500000
	profile.References.MaxVideoPixels = officialSeedanceVideoMaxPixels
	input := canvasGenerationInput{
		Config:          providerConfig{InterfaceType: "newapi", Model: "seedance-2.0", BaseURL: "https://example.com"},
		ReferenceVideos: []providerMedia{{Width: 720, Height: 700, DurationMs: 3000, Bytes: 1}},
	}
	if err := validateVideoReferenceMedia(profile, input); err != nil {
		t.Fatalf("custom 500000 floor rejected 720×700: %v", err)
	}
	input.ReferenceVideos[0].Height = 694
	if err := validateVideoReferenceMedia(profile, input); err == nil {
		t.Fatal("custom 500000 floor accepted 720×694")
	}
	overlay := DefaultModelCapabilityConfigForModel("newapi", "seedance-2.0").Video
	input.ReferenceVideos[0] = providerMedia{Width: 720, Height: 567, DurationMs: 3000, Bytes: 1}
	if err := validateVideoReferenceMedia(overlay, input); err == nil {
		t.Fatal("custom newapi remapped overlay 409600 to 407696")
	}
}

func TestDefaultSeedance25UsesOfficialCounts(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi-channel-2", "seedance-2.5").Video
	if profile.References.MaxImages != 30 || profile.References.MaxVideos != 10 || profile.References.MaxAudios != 10 {
		t.Fatalf("default 2.5 counts = %#v", profile.References)
	}
	if profile.References.MinAudioDuration != 1.8 {
		t.Fatalf("default 2.5 min audio = %v", profile.References.MinAudioDuration)
	}
	if profile.Duration.Max < 30 {
		t.Fatalf("default 2.5 output duration max = %d", profile.Duration.Max)
	}
	if !containsCapabilityString(profile.Operations, "audio_to_video") {
		t.Fatalf("operations = %v", profile.Operations)
	}
}

func TestValidateVideoTaskRejectsImageGeometryAndAllowsLargeLinkedVideo(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi-channel-2", "seedance-2.5").Video
	input := canvasGenerationInput{
		Prompt:          "test",
		Config:          providerConfig{Model: "seedance-2.5", VideoSeconds: "5", Size: "16:9", VQuality: "720p"},
		ReferenceImages: []providerMedia{{Width: 200, Height: 400, Bytes: 1000}},
	}
	err := validateVideoTask(profile, input)
	if err == nil || !strings.Contains(err.Error(), "宽度") || !strings.Contains(err.Error(), "200") || !strings.Contains(err.Error(), "调整尺寸或更换") {
		t.Fatalf("narrow image error = %v", err)
	}
	input.ReferenceImages[0].Width = 800
	input.ReferenceImages[0].Height = 800
	input.ReferenceImages[0].Bytes = 31 * 1024 * 1024
	err = validateVideoTask(profile, input)
	if err == nil || !strings.Contains(err.Error(), "文件过大") || !strings.Contains(err.Error(), "单文件") {
		t.Fatalf("single file error = %v", err)
	}
	input.ReferenceImages = nil
	input.ReferenceVideos = []providerMedia{{
		URL: "https://example.com/large.mp4", Bytes: 100 * 1024 * 1024, Width: 1280, Height: 720, DurationMs: 5000,
	}}
	if err := validateVideoTask(profile, input); err != nil {
		t.Fatalf("linked 100MB video rejected: %v", err)
	}
}

func TestValidateVideoTaskHonorsRequestedDurationAndResolution(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi-channel-2", "seedance-2.5").Video
	input := canvasGenerationInput{Prompt: "test", Config: providerConfig{Model: "seedance-2.5", VideoSeconds: "20", Size: "16:9", VQuality: "1080p"}}
	if err := validateVideoTask(profile, input); err != nil {
		t.Fatalf("20s 1080p rejected: %v", err)
	}
	input.Config.VideoSeconds = "30"
	input.Config.VQuality = "2k"
	if err := validateVideoTask(profile, input); err != nil {
		t.Fatalf("30s 2k rejected: %v", err)
	}
	input.Config.VideoSeconds = "-1"
	if err := validateVideoTask(profile, input); err == nil {
		t.Fatal("adaptive -1 accepted without capability support")
	}
	profile.Duration = VideoDurationConfig{Selection: "enum", Values: []int{5, 10, -1}, Default: 5}
	if err := validateVideoTask(profile, input); err != nil {
		t.Fatalf("explicit -1 rejected: %v", err)
	}
	limited := DefaultModelCapabilityConfigForModel("volcengine-ark-video", "doubao-seedance-2-0-260128").Video
	input.Config.VideoSeconds = "6"
	input.Config.VQuality = "4k"
	if err := validateVideoTask(limited, input); err == nil || !strings.Contains(err.Error(), "输出分辨率") {
		t.Fatalf("unsupported 4k error = %v", err)
	}
}

func TestValidateVideoTaskAllowsSeedance25AudioOnly(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi-channel-2", "seedance-2.5").Video
	input := canvasGenerationInput{
		Prompt:          "follow the soundtrack",
		Config:          providerConfig{Model: "seedance-2.5", VideoSeconds: "5", Size: "16:9", VQuality: "720p"},
		ReferenceAudios: []providerMedia{{DurationMs: 3000, Bytes: 1000, URL: "https://example.com/a.mp3"}},
		Metadata:        map[string]interface{}{"videoEditOperation": "audio_to_video"},
	}
	if err := validateVideoTask(profile, input); err != nil {
		t.Fatalf("audio-only 2.5 rejected: %v", err)
	}
}

func TestSeedanceReferenceDurationRejectsShortAndUnknownBeforeSubmit(t *testing.T) {
	for _, name := range []string{"seedance-2.0-fast", "seedance-2.5"} {
		profile := applyModelSpecificVideoCapability(DefaultModelCapabilityConfigForModel("newapi-channel-2", name).Video, "newapi-channel-2", name)
		input := canvasGenerationInput{Prompt: "test", Config: providerConfig{Model: name, VideoSeconds: "5"}, ReferenceImages: []providerMedia{{Width: 512, Height: 512}}, ReferenceAudios: []providerMedia{{DurationMs: 2500}, {DurationMs: 900}}}
		if err := validateVideoTask(profile, input); err == nil || !strings.Contains(err.Error(), "第 2 段参考音频") || !strings.Contains(err.Error(), "0.90") {
			t.Fatalf("short audio: %v", err)
		}
		input.ReferenceAudios[1].DurationMs = 0
		if err := validateVideoTask(profile, input); err == nil || !strings.Contains(err.Error(), "时长无法读取") {
			t.Fatalf("unknown duration: %v", err)
		}
		input.ReferenceAudios[1].DurationMs = 1700
		if err := validateVideoTask(profile, input); err == nil || !strings.Contains(err.Error(), "1.70") || !strings.Contains(err.Error(), "1.8") {
			t.Fatalf("1.7s audio: %v", err)
		}
		input.ReferenceAudios[1].DurationMs = 1800
		if err := validateVideoTask(profile, input); err != nil {
			t.Fatalf("1.8s audio: %v", err)
		}
	}
}

func TestSeedanceTotalReferenceAudioDuration(t *testing.T) {
	for name, maximum := range map[string]int64{"seedance-2.0": 15000, "seedance-2.5": 30000, "provider/seedance-2.5": 30000, "seedance-2.5-self-developed": 30000} {
		profile := applyModelSpecificVideoCapability(DefaultModelCapabilityConfigForModel("newapi-channel-2", name).Video, "newapi-channel-2", name)
		input := canvasGenerationInput{Prompt: "test", Config: providerConfig{Model: name, VideoSeconds: "5"}, ReferenceImages: []providerMedia{{Width: 512, Height: 512}}, ReferenceAudios: []providerMedia{{DurationMs: maximum / 2}, {DurationMs: maximum / 2}}}
		if err := validateVideoTask(profile, input); err != nil {
			t.Fatalf("%s exact total: %v", name, err)
		}
		input.ReferenceAudios[1].DurationMs += 1000
		if err := validateVideoTask(profile, input); err == nil || !strings.Contains(err.Error(), "参考音频总时长") {
			t.Fatalf("%s excessive total: %v", name, err)
		}
	}
}

func TestSeedanceReferenceDurationWithoutPersistedCapability(t *testing.T) {
	for _, protocol := range []string{"openai", "newapi", "newapi-channel-2"} {
		for _, name := range []string{"seedance-2.5", "provider/seedance-2.0-fast"} {
			input := canvasGenerationInput{Prompt: "test", Config: providerConfig{InterfaceType: protocol, Model: name, VideoSeconds: "5"}, ReferenceImages: []providerMedia{{Width: 512, Height: 512}}, ReferenceAudios: []providerMedia{{DurationMs: 900}}}
			if err := (&Service{}).validateResolvedVideoCapability(&input); err == nil || !strings.Contains(err.Error(), "第 1 段参考音频") {
				t.Fatalf("%s %s bypassed short audio validation: %v", protocol, name, err)
			}
		}
	}
}

func TestValidateImageTaskRejectsOversizedGrokPromptByUTF8Bytes(t *testing.T) {
	prompt := strings.Repeat("中", 4001)
	input := canvasGenerationInput{
		Mode:   "image",
		Prompt: prompt,
		Config: providerConfig{InterfaceType: "grok-image", Model: "grok-imagine-image-quality"},
	}

	err := validateImageTask(DefaultImageCapabilityConfig("grok-image", "grok-imagine-image-quality"), input)
	if err == nil {
		t.Fatal("validateImageTask() error = nil")
	}
	wantBytes := fmt.Sprintf("%d UTF-8 字节", len(prompt))
	if !strings.Contains(err.Error(), wantBytes) || !strings.Contains(err.Error(), "8000") || !strings.Contains(err.Error(), "连线文本") {
		t.Fatalf("validateImageTask() error = %q", err)
	}
}

func TestValidateImageTaskDoesNotApplyQualityPromptLimitToGrokLite(t *testing.T) {
	prompt := strings.Repeat("中", 4001)
	input := canvasGenerationInput{
		Mode:   "image",
		Prompt: prompt,
		Config: providerConfig{InterfaceType: "grok-image", Model: "grok-imagine-image"},
	}

	if err := validateImageTask(DefaultImageCapabilityConfig("grok-image", "grok-imagine-image"), input); err != nil {
		t.Fatalf("validateImageTask() error = %q", err)
	}
}

func TestValidateVideoTaskRejectsPromptAboveCapabilityLimit(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("autodl-comfyui", "MiniMax H3").Video
	profile.References.PromptMaxChars = 10_000
	input := canvasGenerationInput{
		Mode:   "video",
		Prompt: strings.Repeat("镜", 23_142),
		Config: providerConfig{Model: "MiniMax H3", VideoSeconds: "15", Size: "16:9", VQuality: "768p横"},
	}

	err := validateVideoTask(profile, input)
	if err == nil || !strings.Contains(err.Error(), "最多 10000 个字符") || !strings.Contains(err.Error(), "23142 个字符") || !strings.Contains(err.Error(), "不会自动截断") {
		t.Fatalf("validateVideoTask() error = %v", err)
	}
}

// 未公布字符上限的通道不应被宿主编造的限制拒绝。
func TestDefaultVideoPromptMaxCharsAllowsComposedCanvasPrompt(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("seedance-videos-compatible", "sd-2.5").Video
	if profile.References.PromptMaxChars != 0 {
		t.Fatalf("视频默认提示词上限 = %d, want 0", profile.References.PromptMaxChars)
	}

	for _, length := range []int{2399, 8001, 32001} {
		composed := canvasGenerationInput{Mode: "video", Prompt: strings.Repeat("镜", length), Config: providerConfig{Model: "sd-2.5", VideoSeconds: "6", Size: "16:9", VQuality: "720p"}}
		if err := validateVideoTask(profile, composed); err != nil {
			t.Fatalf("合成提示词 %d 字符被拒绝: %v", length, err)
		}
	}
}

func TestValidateTaskCapabilityRejectsWorkflowPromptAboveConfiguredLimit(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("runninghub-workflow-video", "workflow-video")
	profile.Video.References.PromptMaxChars = 10_000
	input := map[string]any{
		"mode":   "video",
		"prompt": strings.Repeat("镜", 10_001),
		"config": map[string]any{
			"interfaceType":    "runninghub-workflow-video",
			"capabilityConfig": profile,
		},
	}

	err := (&Service{}).ValidateTaskCapability(input)
	if err == nil || !strings.Contains(err.Error(), "完整提示词为 10001 个字符") {
		t.Fatalf("ValidateTaskCapability() error = %v", err)
	}
}

func TestValidateImageTaskEnforcesGPTImage2CustomSizeLimits(t *testing.T) {
	profile := DefaultImageCapabilityConfig("openai-image", "gpt-image-2")
	profile.Size.AllowCustom = true

	valid := canvasGenerationInput{Mode: "image", Config: providerConfig{InterfaceType: "openai-image", Model: "gpt-image-2", Size: "3840x1920"}}
	if err := validateImageTask(profile, valid); err != nil {
		t.Fatalf("validateImageTask(valid) error = %v", err)
	}

	tests := map[string]string{
		"4096x2048": "最长边",
		"3840x2161": "16 的倍数",
		"3840x1024": "宽高比",
		"640x640":   "总像素",
	}
	for size, want := range tests {
		t.Run(size, func(t *testing.T) {
			input := canvasGenerationInput{Mode: "image", Config: providerConfig{InterfaceType: "openai-image", Model: "gpt-image-2", Size: size}}
			err := validateImageTask(profile, input)
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("validateImageTask(%s) error = %v, want %q", size, err, want)
			}
		})
	}
}

func TestDefaultVideoCapabilityUsesProtocolSpecificResolutionTiers(t *testing.T) {
	tests := map[string][]string{
		"newapi-channel-2":        {"480p", "720p", "1080p", "1440p", "2160p"},
		"volcengine-ark-video":    {"480p", "720p", "1080p"},
		"volcengine-jimeng-video": {"720p"},
		"gemini-veo":              {"720p", "1080p"},
	}
	for protocol, want := range tests {
		t.Run(protocol, func(t *testing.T) {
			profile := DefaultModelCapabilityConfigForModel(protocol, "")
			if profile == nil || profile.Video == nil {
				t.Fatalf("DefaultModelCapabilityConfigForModel(%q) video profile = nil", protocol)
			}
			if fmt.Sprint(profile.Video.Resolutions) != fmt.Sprint(want) {
				t.Fatalf("resolutions = %v, want %v", profile.Video.Resolutions, want)
			}
		})
	}
}

func TestDefaultMiniMaxVideoCapabilitySupportsReferenceGeneration(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("minimax-video", "MiniMax-H3")
	if profile == nil || profile.Video == nil {
		t.Fatal("MiniMax video profile = nil")
	}
	if !containsCapabilityString(profile.Video.Operations, "reference_to_video") {
		t.Fatalf("operations = %v, want reference_to_video", profile.Video.Operations)
	}
}

func TestAgnesVideo25CapabilityUsesOfficialLimits(t *testing.T) {
	standard := DefaultModelCapabilityConfigForModel("agnes-video", "agnes-video-2.5").Video
	if standard.Duration.Min != 4 || standard.Duration.Max != 12 || standard.Duration.Default != 5 {
		t.Fatalf("Agnes 2.5 duration = %#v", standard.Duration)
	}
	if fmt.Sprint(standard.Resolutions) != fmt.Sprint([]string{"720P", "960P", "2K"}) || standard.References.MaxVideos != 3 {
		t.Fatalf("Agnes 2.5 capability = %#v", standard)
	}
	flash := DefaultModelCapabilityConfigForModel("agnes-video", "agnes-video-2.5-flash").Video
	if fmt.Sprint(flash.Resolutions) != fmt.Sprint([]string{"720P"}) || flash.References.MaxImages != 5 || flash.References.MaxVideos != 0 {
		t.Fatalf("Agnes 2.5 Flash capability = %#v", flash)
	}
}

func TestNormalizeAgnesVideo25CapabilityRepairsLegacyStoredLimits(t *testing.T) {
	legacy := DefaultModelCapabilityConfigForModel("newapi", "legacy-video")
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "agnes-video", "agnes-video-2.5", legacy)
	if err != nil {
		t.Fatalf("NormalizeModelCapabilityConfigForModel() error = %v", err)
	}
	if normalized.Video.Duration.Min != 4 || normalized.Video.Duration.Max != 12 || normalized.Video.Duration.Default != 5 {
		t.Fatalf("normalized duration = %#v", normalized.Video.Duration)
	}
	if fmt.Sprint(normalized.Video.Resolutions) != fmt.Sprint([]string{"720P", "960P", "2K"}) {
		t.Fatalf("normalized resolutions = %v", normalized.Video.Resolutions)
	}
	input := canvasGenerationInput{Config: providerConfig{InterfaceType: "agnes-video", Model: "agnes-video-2.5", VideoSeconds: "15", Size: "16:9", VQuality: "720P"}}
	if err := validateVideoTask(normalized.Video, input); err == nil {
		t.Fatalf("validateVideoTask(15 seconds) error = %v", err)
	}
}

func TestDefaultVolcengineArkVideoCapabilitySupportsFullModalReference(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("volcengine-ark-video", "doubao-seedance-2-0-260128")
	if profile == nil || profile.Video == nil {
		t.Fatal("Volcengine Ark video profile = nil")
	}
	for _, operation := range []string{"reference_to_video"} {
		if !containsCapabilityString(profile.Video.Operations, operation) {
			t.Fatalf("operations = %v, want %s", profile.Video.Operations, operation)
		}
	}
	if containsCapabilityString(profile.Video.Operations, "audio_to_video") {
		t.Fatal("Seedance 2.0 must not advertise audio-only generation")
	}
	if profile.Video.References.MaxImages != 9 || profile.Video.References.MaxVideos != 3 || profile.Video.References.MaxAudios != 3 {
		t.Fatalf("reference limits = %#v", profile.Video.References)
	}
}

func TestValidateVolcengineArkFullModalReferenceRejectsTextAndAudioOnly(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("volcengine-ark-video", "doubao-seedance-2-0-260128").Video
	input := canvasGenerationInput{
		Prompt:          "follow the soundtrack",
		Config:          providerConfig{InterfaceType: "volcengine-ark-video", VideoSeconds: "6", Size: "16:9", VQuality: "720p"},
		ReferenceAudios: []providerMedia{{URL: "https://example.com/music.mp3", DurationMs: 3000}},
		Metadata:        map[string]interface{}{"videoEditOperation": "audio_to_video"},
	}
	err := validateVideoTask(profile, input)
	if err == nil || !strings.Contains(err.Error(), "不支持只用音频") {
		t.Fatalf("validateVideoTask() error = %v", err)
	}

	input.ReferenceImages = []providerMedia{{URL: "https://example.com/subject.png"}}
	input.Metadata["videoEditOperation"] = "reference_to_video"
	if err := validateVideoTask(profile, input); err != nil {
		t.Fatalf("validateVideoTask(full modal) error = %v", err)
	}
}

func TestNormalizeBeefAPISeedanceFullModalReferenceCapability(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi", "seedance-2.0-fast")
	if profile == nil || profile.Video == nil {
		t.Fatal("BeefAPI Seedance video profile = nil")
	}

	normalized, err := NormalizeModelCapabilityConfigForModel("video", "newapi", "seedance-2.0-fast", profile)
	if err != nil {
		t.Fatalf("NormalizeModelCapabilityConfigForModel() error = %v", err)
	}
	if normalized.Video.References.MaxVideos < 3 {
		t.Fatalf("max videos = %d, want at least 3", normalized.Video.References.MaxVideos)
	}
	if !normalized.Video.GenerateAudio.Supported {
		t.Fatal("BeefAPI Seedance must expose the audio toggle")
	}
	if !containsCapabilityString(normalized.Video.Operations, "reference_to_video") {
		t.Fatalf("operations = %v, want reference_to_video", normalized.Video.Operations)
	}
}

func TestCapabilitySpecFromModelCapabilityConfigRestoresLegacyWildcardImageSizes(t *testing.T) {
	config := &ModelCapabilityConfig{
		Version: 1,
		Image: &ImageCapabilityConfig{
			Size: ImageSizeConfig{Parameter: "size", Values: []string{"*"}, AllowCustom: true},
		},
	}

	spec, err := CapabilitySpecFromModelCapabilityConfig(config, "image")
	if err != nil {
		t.Fatalf("CapabilitySpecFromModelCapabilityConfig() error = %v", err)
	}
	constraint, ok := spec.Options["size"]
	if !ok {
		t.Fatal("size constraint is missing")
	}
	values := make(map[string]int)
	for _, value := range constraint.Values {
		values[fmt.Sprint(value)]++
	}
	for _, value := range legacyImageSizeValues() {
		if values[value] != 1 {
			t.Fatalf("size constraint missing %q: %v", value, constraint.Values)
		}
	}
	if values["*"] != 1 {
		t.Fatalf("size constraint wildcard count = %d, values = %v", values["*"], constraint.Values)
	}
}

func TestNormalizeResolutionSupportsCommonAliases(t *testing.T) {
	tests := map[string]string{
		"1440":  "1440p",
		"1440p": "1440p",
		"2K":    "1440p",
		"4K":    "2160p",
		"768P":  "768p",
	}
	for input, want := range tests {
		if got := normalizeResolution(input); got != want {
			t.Fatalf("normalizeResolution(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestValidateVideoTaskIgnoresGlobalResolutionWhenCatalogDeclaresNone(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi", "omni").Video
	profile.Duration = VideoDurationConfig{Selection: "enum", Values: []int{8, 10}, Default: 10}
	profile.Ratios = []string{"16:9", "9:16"}
	profile.DefaultRatio = "16:9"
	profile.Resolutions = nil
	profile.DefaultResolution = ""
	profile.References.MaxImages = 0
	profile.Operations = []string{"text_to_video"}
	profile.DefaultOperation = "text_to_video"

	err := validateVideoTask(profile, canvasGenerationInput{
		Config: providerConfig{Model: "omni", VideoSeconds: "10", Size: "16:9", VQuality: "720"},
	})
	if err != nil {
		t.Fatalf("validateVideoTask() error = %v", err)
	}
}

func TestNormalizeVideoCapabilityAllowsOmittedResolution(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi-channel-2", "endpoint-video").Video
	profile.Resolutions = nil
	profile.DefaultResolution = ""

	result, err := NormalizeModelCapabilityConfig("video", "newapi-channel-2", &ModelCapabilityConfig{Version: 1, Video: profile})
	if err != nil {
		t.Fatalf("NormalizeModelCapabilityConfig() error = %v", err)
	}
	if result.Video == nil || len(result.Video.Resolutions) != 0 || result.Video.DefaultResolution != "" {
		t.Fatalf("normalized video resolution = %#v", result.Video)
	}
}

func TestNormalizeVideoCapabilityAllowsOmittedRatio(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("autodl-comfyui", "minimax_h3_lightx2v_no_pic").Video
	profile.Ratios = nil
	profile.DefaultRatio = ""
	profile.Resolutions = []string{"480p竖", "480p横"}
	profile.DefaultResolution = "480p竖"

	result, err := NormalizeModelCapabilityConfig("video", "autodl-comfyui", &ModelCapabilityConfig{Version: 1, Video: profile})
	if err != nil {
		t.Fatalf("NormalizeModelCapabilityConfig() error = %v", err)
	}
	if result.Video == nil || len(result.Video.Ratios) != 0 || result.Video.DefaultRatio != "" {
		t.Fatalf("normalized video ratios = %#v", result.Video)
	}
	if err := validateVideoTask(result.Video, canvasGenerationInput{Config: providerConfig{Model: "minimax_h3_lightx2v_no_pic", VideoSeconds: "6", VQuality: "480p竖"}}); err != nil {
		t.Fatalf("validateVideoTask() error = %v", err)
	}
}

func TestCapabilitySpecFromModelCapabilityConfigProjectsImageSizePresets(t *testing.T) {
	config := &ModelCapabilityConfig{
		Version: 1,
		Image: &ImageCapabilityConfig{
			References: ImageReferenceConfig{MaxImages: 4},
			Size: ImageSizeConfig{
				Parameter: "aspect_ratio",
				Values:    []string{"16:9"},
				Default:   "16:9",
				Presets: []ImageSizePreset{
					{Tier: "4k", Ratio: "16:9", Size: "3840x2160", Width: 3840, Height: 2160},
				},
			},
			Quality:    ImageQualityConfig{Supported: false, Default: "auto"},
			MaxOutputs: 1,
		},
	}
	spec, err := CapabilitySpecFromModelCapabilityConfig(config, "image")
	if err != nil {
		t.Fatal(err)
	}
	if spec.Options["quality"].Values != nil {
		t.Fatalf("quality must stay undeclared when unsupported: %#v", spec.Options["quality"])
	}
	if spec.ImageSize == nil || spec.ImageSize.Parameter != "aspect_ratio" || len(spec.ImageSize.Presets) != 1 || spec.ImageSize.Presets[0].Tier != "4k" {
		t.Fatalf("imageSize presets = %#v", spec.ImageSize)
	}
}

func TestCapabilitySpecFromModelCapabilityConfigProjectsImageSizeOnce(t *testing.T) {
	config := &ModelCapabilityConfig{
		Version: 1,
		Image: &ImageCapabilityConfig{
			References: ImageReferenceConfig{MaxImages: 3, MaskSupported: false},
			Size:       ImageSizeConfig{Parameter: "size", Values: []string{"1:1", "16:9"}, AllowCustom: true},
			MaxOutputs: 4,
		},
	}

	spec, err := CapabilitySpecFromModelCapabilityConfig(config, "image")
	if err != nil {
		t.Fatalf("CapabilitySpecFromModelCapabilityConfig() error = %v", err)
	}
	if got := spec.Options["size"].Values; len(got) != 3 || got[0] != "1:1" || got[1] != "16:9" || got[2] != "*" {
		t.Fatalf("size projection = %#v, want configured values plus wildcard", got)
	}
	if got := spec.Inputs["image"].Max; got != 3 {
		t.Fatalf("image input max = %d, want 3", got)
	}
	if got := spec.Options["count"].Max; got == nil || *got != 4 {
		t.Fatalf("count max = %v, want 4", got)
	}
}

func TestCapabilitySpecFromModelCapabilityConfigProjectsCustomImageSizeAsWildcard(t *testing.T) {
	config := &ModelCapabilityConfig{
		Version: 1,
		Image: &ImageCapabilityConfig{
			Size:       ImageSizeConfig{Parameter: "size", Values: []string{"1:1"}, AllowCustom: true},
			MaxOutputs: 1,
		},
	}

	spec, err := CapabilitySpecFromModelCapabilityConfig(config, "image")
	if err != nil {
		t.Fatalf("CapabilitySpecFromModelCapabilityConfig() error = %v", err)
	}
	if got := spec.Options["size"].Values; len(got) != 2 || got[0] != "1:1" || got[1] != "*" {
		t.Fatalf("custom size projection = %#v, want configured value plus wildcard", got)
	}
}

func TestCapabilitySpecFromModelCapabilityConfigAllowsAudioWithoutConfig(t *testing.T) {
	spec, err := CapabilitySpecFromModelCapabilityConfig(nil, "audio")
	if err != nil {
		t.Fatalf("audio projection error = %v", err)
	}
	if spec.Capability != "audio" || len(spec.Inputs) != 0 || len(spec.Options) != 0 {
		t.Fatalf("audio projection = %#v", spec)
	}
}

func TestValidateVideoTaskRequiresDeclaredMinimumImages(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi-channel-2", "image-required-video").Video
	profile.References.MinImages = 1
	profile.References.MaxImages = 2
	profile.Operations = []string{"image_to_video"}
	profile.DefaultOperation = "image_to_video"

	err := validateVideoTask(profile, canvasGenerationInput{
		Config: providerConfig{Model: "image-required-video", VideoSeconds: "6", Size: "16:9", VQuality: "720"},
	})
	if err == nil || !strings.Contains(err.Error(), "至少需要 1 张参考图") {
		t.Fatalf("validateVideoTask() error = %v", err)
	}
}
