package modelcatalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/workspace"
)

func TestResolveAssistantGenerationModelUsesEffectiveHostedVideoOverlay(t *testing.T) {
	dir := t.TempDir()
	legacy := []byte(`{
		"imageModel":"beefapi::gpt-image-2",
		"videoModel":"beefapi::wan3.0-video",
		"channels":[
			{
				"id":"beefapi",
				"name":"BeefAPI",
				"baseUrl":"https://enterprise.beefapi.com",
				"enabled":true,
				"pinned":true,
				"models":["gpt-image-2","wan3.0-video","seedance-2.0-fast"],
				"modelProfiles":[
					{"model":"gpt-image-2","capability":"image","protocol":"openai-image"},
					{"model":"wan3.0-video","capability":"video","protocol":"newapi-channel-2"},
					{"model":"seedance-2.0-fast","capability":"text","protocol":"chat-completion"}
				]
			},
			{
				"id":"custom-gateway",
				"baseUrl":"https://example.invalid/v1",
				"enabled":true,
				"models":["seedance-2.0-fast","gpt-image-2"],
				"modelProfiles":[
					{"model":"seedance-2.0-fast","capability":"text","protocol":"chat-completion"},
					{"model":"gpt-image-2","capability":"video","protocol":"newapi"}
				]
			}
		]
	}`)
	if err := os.WriteFile(filepath.Join(dir, workspace.LocalProviderConfigFile), legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := workspace.NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}

	body, err := json.Marshal(effective.Config)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot AssistantConfigSnapshot
	if err := json.Unmarshal(body, &snapshot); err != nil {
		t.Fatal(err)
	}
	snapshot.Revision = effective.Revision

	fastVideo := ResolveAssistantGenerationModel(snapshot, "video", "beefapi::seedance-2.0-fast")
	if fastVideo.KindMismatch || !fastVideo.FromNode || fastVideo.ModelKey != "beefapi::seedance-2.0-fast" {
		t.Fatalf("hosted Fast must propose video: %#v", fastVideo)
	}

	imageOnVideo := ResolveAssistantGenerationModel(snapshot, "video", "beefapi::gpt-image-2")
	if !imageOnVideo.KindMismatch || imageOnVideo.ModelKey != "" {
		t.Fatalf("hosted image on video propose: %#v", imageOnVideo)
	}
	fastOnImage := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::seedance-2.0-fast")
	if !fastOnImage.KindMismatch || fastOnImage.ModelKey != "" {
		t.Fatalf("hosted Fast on image propose: %#v", fastOnImage)
	}
	customFastVideo := ResolveAssistantGenerationModel(snapshot, "video", "custom-gateway::seedance-2.0-fast")
	if !customFastVideo.KindMismatch || customFastVideo.ModelKey != "" {
		t.Fatalf("custom text Fast must stay a type error: %#v", customFastVideo)
	}
	customImageVideo := ResolveAssistantGenerationModel(snapshot, "image", "custom-gateway::gpt-image-2")
	if !customImageVideo.KindMismatch || customImageVideo.ModelKey != "" {
		t.Fatalf("custom image-as-video mislabel must still be rejected: %#v", customImageVideo)
	}
	unknown := ResolveAssistantGenerationModel(snapshot, "video", "beefapi::missing-video")
	if unknown.FromNode || unknown.KindMismatch || unknown.ModelKey != "" {
		t.Fatalf("unknown explicit selection must not fall back: %#v", unknown)
	}
	fallback := ResolveAssistantGenerationModel(snapshot, "video", "")
	if fallback.FromNode || fallback.KindMismatch || fallback.ModelKey != "beefapi::wan3.0-video" {
		t.Fatalf("empty selection should keep the user video default: %#v", fallback)
	}
}
