package modelcatalog

import (
	"encoding/json"
	"testing"
)

func TestResolveAssistantAudioGenerationModel(t *testing.T) {
	var snapshot AssistantConfigSnapshot
	if err := json.Unmarshal([]byte(`{"audioModel":"beefapi::speech-default","channels":[{"id":"beefapi","enabled":true,"models":["speech-default","speech-other","speech-protocol"],"modelAliases":{"old-voice":"speech-other"},"modelProfiles":[{"model":"speech-default","capability":"audio"},{"model":"speech-other","capability":"audio"},{"model":"speech-protocol","protocol":"openai-audio"}]}]}`), &snapshot); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, selected, want string
		fromNode             bool
	}{
		{name: "saved audio default", want: "speech-default"},
		{name: "explicit audio", selected: "beefapi::speech-other", want: "speech-other", fromNode: true},
		{name: "unqualified audio", selected: "speech-other", want: "speech-other", fromNode: true},
		{name: "alias audio", selected: "old-voice", want: "speech-other", fromNode: true},
		{name: "audio protocol", selected: "speech-protocol", want: "speech-protocol", fromNode: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			choice := ResolveAssistantGenerationModel(snapshot, "audio", test.selected)
			if choice.KindMismatch || choice.FromNode != test.fromNode || choice.ModelKey != "beefapi::"+test.want || choice.Display != test.want {
				t.Fatalf("audio selection: %#v", choice)
			}
		})
	}
}

func TestResolveAssistantGenerationModelRejectsAudioKindMismatch(t *testing.T) {
	var snapshot AssistantConfigSnapshot
	if err := json.Unmarshal([]byte(`{"imageModel":"beefapi::image","videoModel":"beefapi::video","audioModel":"beefapi::speech","channels":[{"id":"beefapi","enabled":true,"models":["image","video","speech","extra-speech"],"modelProfiles":[{"model":"image","capability":"image"},{"model":"video","capability":"video"},{"model":"speech","capability":"audio"},{"model":"extra-speech","capability":"audio"}]}]}`), &snapshot); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ kind, selected string }{
		{"audio", "image"}, {"audio", "video"}, {"image", "speech"}, {"video", "speech"},
		{"image", "extra-speech"}, {"video", "extra-speech"},
	} {
		t.Run(test.kind+"/"+test.selected, func(t *testing.T) {
			choice := ResolveAssistantGenerationModel(snapshot, test.kind, test.selected)
			if !choice.KindMismatch || choice.ModelKey != "" {
				t.Fatalf("cross-kind selection must not generate: %#v", choice)
			}
		})
	}
}

func TestResolveAssistantAudioModelUnavailableDoesNotUsePaidDefault(t *testing.T) {
	var snapshot AssistantConfigSnapshot
	if err := json.Unmarshal([]byte(`{"audioModel":"on::speech","channels":[{"id":"on","enabled":true,"models":["speech","mystery"],"modelProfiles":[{"model":"speech","capability":"audio"},{"model":"removed","capability":"audio"},{"model":"mystery"}]},{"id":"off","enabled":false,"models":["speech"],"modelProfiles":[{"model":"speech","capability":"audio"}]}]}`), &snapshot); err != nil {
		t.Fatal(err)
	}
	for _, selected := range []string{"on::missing", "on::removed", "off::speech", "on::mystery", "missing"} {
		t.Run(selected, func(t *testing.T) {
			choice := ResolveAssistantGenerationModel(snapshot, "audio", selected)
			if choice.ModelKey != "" || choice.FromNode || choice.KindMismatch {
				t.Fatalf("unavailable explicit audio selection must not fall back: %#v", choice)
			}
		})
	}
}

func TestResolveAssistantGenerationModelPrefersNodeOverride(t *testing.T) {
	snapshot := AssistantConfigSnapshot{
		ImageModel: "beefapi::gpt-image-2",
		VideoModel: "beefapi::wan3.0-video",
		Channels: []AssistantChannel{{
			ID: "beefapi", Enabled: true,
			ModelProfiles: []AssistantModelProfile{
				{Model: "gpt-image-2", Capability: "image"},
				{Model: "gpt-image-2.5-flare", Capability: "image"},
				{Model: "wan3.0-video", Capability: "video"},
			},
		}},
	}

	choice := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::gpt-image-2.5-flare")
	if choice.KindMismatch || !choice.FromNode || choice.ModelKey != "beefapi::gpt-image-2.5-flare" || choice.Display != "gpt-image-2.5-flare" {
		t.Fatalf("node override: %#v", choice)
	}

	fallback := ResolveAssistantGenerationModel(snapshot, "image", "")
	if fallback.FromNode || fallback.KindMismatch || fallback.ModelKey != "beefapi::gpt-image-2" || fallback.Display != "gpt-image-2" {
		t.Fatalf("global default: %#v", fallback)
	}

	unknown := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::missing-image")
	if unknown.FromNode || unknown.KindMismatch || unknown.ModelKey != "" {
		t.Fatalf("unknown explicit selection must not use a paid default: %#v", unknown)
	}
}

func TestResolveAssistantGenerationModelRejectsKindMismatch(t *testing.T) {
	snapshot := AssistantConfigSnapshot{
		ImageModel: "beefapi::gpt-image-2",
		VideoModel: "beefapi::wan3.0-video",
		Channels: []AssistantChannel{{
			ID: "beefapi", Enabled: true,
			ModelProfiles: []AssistantModelProfile{
				{Model: "gpt-image-2", Capability: "image"},
				{Model: "wan3.0-video", Capability: "video"},
			},
		}},
	}

	fromCatalog := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::wan3.0-video")
	if !fromCatalog.KindMismatch || fromCatalog.ModelKey != "" {
		t.Fatalf("catalog video model on image propose: %#v", fromCatalog)
	}

	fromDefault := ResolveAssistantGenerationModel(snapshot, "image", snapshot.VideoModel)
	if !fromDefault.KindMismatch {
		t.Fatalf("other-kind default should conflict: %#v", fromDefault)
	}

	okVideo := ResolveAssistantGenerationModel(snapshot, "video", "beefapi::wan3.0-video")
	if okVideo.KindMismatch || okVideo.ModelKey != "beefapi::wan3.0-video" {
		t.Fatalf("matching video selection: %#v", okVideo)
	}
}

func TestResolveAssistantGenerationModelNormalizesUnqualifiedKey(t *testing.T) {
	snapshot := AssistantConfigSnapshot{
		ImageModel: "beefapi::gpt-image-2",
		Channels: []AssistantChannel{{
			ID: "beefapi", Enabled: true,
			Models:       []string{"gpt-image-2", "gpt-image-2.5-flare"},
			ModelAliases: map[string]string{"legacy-flare": "gpt-image-2.5-flare"},
			ModelProfiles: []AssistantModelProfile{
				{Model: "gpt-image-2", Capability: "image"},
				{Model: "gpt-image-2.5-flare", Capability: "image"},
			},
		}},
	}

	unqualified := ResolveAssistantGenerationModel(snapshot, "image", "gpt-image-2.5-flare")
	if unqualified.KindMismatch || !unqualified.FromNode || unqualified.ModelKey != "beefapi::gpt-image-2.5-flare" || unqualified.Display != "gpt-image-2.5-flare" {
		t.Fatalf("unqualified stored model should canonicalize: %#v", unqualified)
	}

	aliased := ResolveAssistantGenerationModel(snapshot, "image", "legacy-flare")
	if aliased.KindMismatch || !aliased.FromNode || aliased.ModelKey != "beefapi::gpt-image-2.5-flare" {
		t.Fatalf("alias should canonicalize like frontend: %#v", aliased)
	}

	unknown := ResolveAssistantGenerationModel(snapshot, "image", "not-in-channel-models")
	if unknown.FromNode || unknown.KindMismatch || unknown.ModelKey != "" {
		t.Fatalf("unknown unqualified model must be rejected: %#v", unknown)
	}
}

func TestResolveAssistantGenerationModelInfersCapabilityFromProtocol(t *testing.T) {
	snapshot := AssistantConfigSnapshot{
		ImageModel: "beefapi::gpt-image-2",
		Channels: []AssistantChannel{{
			ID: "beefapi", Enabled: true,
			Models: []string{"gpt-image-2", "gpt-image-2.5-flare", "mystery"},
			ModelProfiles: []AssistantModelProfile{
				{Model: "gpt-image-2", Capability: "image"},
				{Model: "gpt-image-2.5-flare", Protocol: "openai-image"},
				{Model: "mystery"},
			},
		}},
	}

	inferred := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::gpt-image-2.5-flare")
	if inferred.KindMismatch || !inferred.FromNode || inferred.ModelKey != "beefapi::gpt-image-2.5-flare" {
		t.Fatalf("empty capability with openai-image protocol should match image: %#v", inferred)
	}

	unknown := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::mystery")
	if unknown.FromNode || unknown.KindMismatch || unknown.ModelKey != "" {
		t.Fatalf("unresolved capability must not select another model: %#v", unknown)
	}
}
