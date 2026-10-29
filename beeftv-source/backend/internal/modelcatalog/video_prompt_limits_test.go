package modelcatalog

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestVideoPromptDefaultsUseEndpointContracts(t *testing.T) {
	for _, tc := range []struct {
		protocol, name string
		chars, units   int
	}{
		{"full-video", "sd-native-full-2.5", 4000, 0},
		{"openai-videos", "sora-2-pro", 32000, 0},
		{"newapi", "custom-sora-2-pro", 0, 0},
		{"minimax-video", "MiniMax-H3", 7000, 0},
		{"minimax-video", "MiniMax-Hailuo-2.3", 0, 0},
		{"dashscope-wan-video", "wan3.0-t2v", 20000, 0},
		{"dashscope-wan-video", "wan2.7-i2v", 5000, 0},
		{"dashscope-wan-video", "wan2.6-t2v", 1500, 0},
		{"dashscope-wan-video", "wan2.1-t2v", 800, 0},
		{"kling-video", "kling-v2", 0, 0},
		{"luma-dream-machine", "ray-2", 5000, 0},
		{"pixverse-video", "v6-max", 5000, 0},
		{"zhipu-cogvideox", "cogvideox-3", 512, 0},
		{"volcengine-jimeng-video", "jimeng_t2v_v30", 800, 0},
		{"volcengine-jimeng-video", "jimeng_v30", 0, 0},
		{"runway-video", "gen4_turbo", 0, 1000},
		{"runway-video", "veo3.1", 0, 1000},
		{"runway-video", "seedance2_5", 15000, 0},
		{"runway-video", "seedance2.5", 0, 0},
		{"runway-video", "happyhorse_1_0", 0, 2500},
		{"runway-video", "gemini_omni_flash", 4000, 0},
		{"runway-video", "seedance2", 3500, 0},
		{"volcengine-ark-video", "seedance-2.5", 0, 0},
		{"gemini-veo", "veo-3", 0, 0},
		{"newapi", "minimax-h3", 0, 0},
		{"runninghub-workflow-video", "wan2.1-t2v", 0, 0},
	} {
		t.Run(tc.protocol+"/"+tc.name, func(t *testing.T) {
			refs := DefaultModelCapabilityConfigForModel(tc.protocol, tc.name).Video.References
			if refs.PromptMaxChars != tc.chars || refs.PromptMaxUTF16Units != tc.units {
				t.Fatalf("got chars=%d units=%d, want chars=%d units=%d", refs.PromptMaxChars, refs.PromptMaxUTF16Units, tc.chars, tc.units)
			}
		})
	}
}

func TestVideoPromptLengthCountsTheDeclaredUnit(t *testing.T) {
	for _, tc := range []struct {
		name, prompt string
		refs         VideoReferenceConfig
		wantError    string
	}{
		{"unpublished", strings.Repeat("镜", 32001), VideoReferenceConfig{}, ""},
		{"unicode-char-boundary", "中😀a", VideoReferenceConfig{PromptMaxChars: 3}, ""},
		{"unicode-char-over", "中😀ab", VideoReferenceConfig{PromptMaxChars: 3}, "完整提示词为 4 个字符"},
		{"utf16-boundary", strings.Repeat("😀", 500), VideoReferenceConfig{PromptMaxUTF16Units: 1000}, ""},
		{"utf16-over", strings.Repeat("😀", 500) + "中", VideoReferenceConfig{PromptMaxUTF16Units: 1000}, "完整提示词为 1001 个单位"},
		{"both-char-limit", "abcde", VideoReferenceConfig{PromptMaxChars: 4, PromptMaxUTF16Units: 6}, "最多 4 个字符"},
		{"both-unit-limit", "😀😀😀", VideoReferenceConfig{PromptMaxChars: 4, PromptMaxUTF16Units: 5}, "最多 5 个 UTF-16 单位"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateVideoPromptLength(tc.prompt, tc.refs)
			if tc.wantError == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("got %v, want %q", err, tc.wantError)
			}
		})
	}
}

func TestConfiguredAndWorkflowVideoPathsEnforceUTF16(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("runway-video", "gen4_turbo")
	profile.Video.References.PromptMaxUTF16Units = 4
	body, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	lookup := func(_, _ string) (*model.ChannelModel, error) {
		return &model.ChannelModel{ModelKey: "gen4_turbo", Protocol: "runway-video", CapabilityConfigJSON: string(body)}, nil
	}
	for name, validate := range map[string]func(TaskInput) error{
		"video":      func(input TaskInput) error { return ValidateVideoTask(profile.Video, input) },
		"parameters": func(input TaskInput) error { return ValidateVideoTaskParameters(profile.Video, input) },
		"custom-channel": func(input TaskInput) error {
			_, err := ValidateConfiguredTask(input, nil)
			return err
		},
		"stored-channel": func(input TaskInput) error {
			input.Config.ChannelID = "test-channel"
			_, err := ValidateConfiguredTask(input, lookup)
			return err
		},
		"workflow": ValidateWorkflowProviderPromptLength,
	} {
		t.Run(name, func(t *testing.T) {
			input := TaskInput{Mode: "video", Prompt: "😀😀", Config: TaskConfig{
				InterfaceType: "runway-video", Model: "gen4_turbo", VideoSeconds: "6", CapabilityConfig: profile,
			}}
			if err := validate(input); err != nil {
				t.Fatalf("boundary rejected: %v", err)
			}
			input.Prompt += "中"
			if err := validate(input); err == nil || !strings.Contains(err.Error(), "UTF-16") {
				t.Fatalf("UTF-16 limit not applied: %v", err)
			}
		})
	}
}

func TestVideoNormalizationPreservesExplicitLimits(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("runway-video", "gen4_turbo")
	profile.Video.References.PromptMaxChars = 4096
	profile.Video.References.PromptMaxUTF16Units = 2048
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "runway-video", "gen4_turbo", profile)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Video.References.PromptMaxChars != 4096 || normalized.Video.References.PromptMaxUTF16Units != 2048 {
		t.Fatal("normalization overwrote a configured limit with a protocol default")
	}
	for _, limits := range [][2]int{{0, 0}, {0, 1000}} {
		profile.Video.References.PromptMaxChars, profile.Video.References.PromptMaxUTF16Units = limits[0], limits[1]
		if _, err := NormalizeModelCapabilityConfigForModel("video", "runway-video", "gen4_turbo", profile); err != nil {
			t.Fatalf("valid optional limit rejected: %v", err)
		}
	}
	for _, limits := range [][2]int{{-1, 0}, {0, -1}, {1000001, 0}, {0, 1000001}} {
		profile.Video.References.PromptMaxChars, profile.Video.References.PromptMaxUTF16Units = limits[0], limits[1]
		if _, err := NormalizeModelCapabilityConfigForModel("video", "runway-video", "gen4_turbo", profile); err == nil {
			t.Fatalf("invalid limits accepted: %v", limits)
		}
	}
	if refs := DefaultModelCapabilityConfig("newapi"); refs.Text.References.PromptMaxChars != 32000 || refs.Image.References.PromptMaxChars != 32000 {
		t.Fatal("video changes altered text/image defaults")
	}
}

func TestVideoPromptSerializationKeepsExplicitZeroUTF16(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("runway-video", "gen4_turbo")
	profile.Video.References.PromptMaxChars = 8000
	profile.Video.References.PromptMaxUTF16Units = 0
	body, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	var stored struct {
		Video struct {
			References map[string]json.RawMessage `json:"references"`
		} `json:"video"`
	}
	if err := json.Unmarshal(body, &stored); err != nil {
		t.Fatal(err)
	}
	if value, present := stored.Video.References["promptMaxUtf16Units"]; !present || string(value) != "0" {
		t.Fatalf("explicit zero must survive serialization: %s", body)
	}
	reloaded, err := DecodeModelCapabilityConfig(string(body))
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Video.References.PromptMaxChars != 8000 || reloaded.Video.References.PromptMaxUTF16Units != 0 {
		t.Fatalf("saved limits changed after decoding: %#v", reloaded.Video.References)
	}
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "runway-video", "gen4_turbo", reloaded)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateVideoPromptLength(strings.Repeat("😀", 1001), normalized.Video.References); err != nil {
		t.Fatalf("disabled UTF-16 limit was restored from defaults: %v", err)
	}
}
