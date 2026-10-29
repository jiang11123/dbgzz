package providerpreset

import "testing"

func TestBeefAPIPresetIsPinnedWithoutFreezingRemoteModelCatalog(t *testing.T) {
	preset := BeefAPI()
	if preset.ID != "beefapi" {
		t.Fatalf("preset id = %q", preset.ID)
	}
	if preset.DisplayName != "BeefTV" || preset.BaseURL != "https://beeftv.app" {
		t.Fatalf("unexpected BeefAPI identity: %#v", preset)
	}
	if !preset.Pinned || preset.PresetVersion < 1 {
		t.Fatalf("preset must be pinned and versioned: %#v", preset)
	}

	if len(preset.Models) != 0 {
		t.Fatalf("remote BeefAPI catalog must be fetched, got %d hard-coded models", len(preset.Models))
	}
}

func TestCatalogValidationRejectsUnsafeOrAmbiguousPresets(t *testing.T) {
	valid := BeefAPI()
	valid.Models = []ModelProfile{{Model: "test", Capability: "text", Protocol: "chat-completion", CapabilityConfig: []byte(`{"version":1,"text":{"streaming":true}}`)}}
	tests := []struct {
		name   string
		mutate func(*ChannelPreset)
	}{
		{name: "duplicate model", mutate: func(preset *ChannelPreset) { preset.Models = append(preset.Models, preset.Models[0]) }},
		{name: "unknown protocol", mutate: func(preset *ChannelPreset) { preset.Models[0].Protocol = "mystery" }},
		{name: "missing capability", mutate: func(preset *ChannelPreset) { preset.Models[0].Capability = "" }},
		{name: "secret field", mutate: func(preset *ChannelPreset) { preset.Metadata = map[string]any{"apiKey": "must-not-ship"} }},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid.Clone()
			test.mutate(&candidate)
			if err := Validate(candidate); err == nil {
				t.Fatal("invalid preset was accepted")
			}
		})
	}
}
