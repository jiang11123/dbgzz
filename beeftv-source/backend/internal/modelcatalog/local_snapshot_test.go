package modelcatalog

import "testing"

func TestParseAndFilterLocalChannelModels(t *testing.T) {
	body := []byte(`{"channels":[{"id":"ch1","baseUrl":"https://example.com/v1","enabled":true,"models":["img","skip"],"modelProfiles":[{"model":"img","displayName":"Image","capability":"image","protocol":"openai-image"}]}]}`)
	items := ParseLocalChannelModels(body)
	if len(items) != 2 || items[0].Model != "img" || items[0].DisplayName != "Image" {
		t.Fatalf("parsed = %#v", items)
	}
	filtered := FilterLocalChannelModels(items, &ModelRequestIntent{Capability: "image"})
	if len(filtered) != 1 || filtered[0].Model != "img" {
		t.Fatalf("filtered = %#v", filtered)
	}
	if got := FilterLocalChannelModels(items, &ModelRequestIntent{Capability: "video"}); len(got) != 0 {
		t.Fatalf("video filter = %#v", got)
	}
}

func TestGenerationModeSupportedUsesCanvasRegistry(t *testing.T) {
	if !GenerationModeSupported("image") || !GenerationModeSupported("video") {
		t.Fatal("image and video generation modes should be supported")
	}
	if GenerationModeSupported("not-a-mode") {
		t.Fatal("unknown mode treated as supported")
	}
}
