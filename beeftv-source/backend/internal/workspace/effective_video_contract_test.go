package workspace

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestEffectiveConfigOverlaysStaleHostedSeedanceProfiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, LocalProviderConfigFile)
	if err := os.WriteFile(path, staleHostedSeedanceConfig(), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	// A canonical encrypted snapshot lets this test still assert that computing
	// the effective overlay does not persist catalog edits.
	document, _, err := decodeProviderDocument(staleHostedSeedanceConfig())
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := store.encodeStoredDocument(document)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, canonical, 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("effective overlay must not rewrite the on-disk snapshot")
	}
	if effective.Config["imageModel"] != "beefapi::gpt-image-2" || effective.Config["videoModel"] != "beefapi::wan3.0-video" {
		t.Fatalf("user defaults changed: image=%#v video=%#v", effective.Config["imageModel"], effective.Config["videoModel"])
	}

	hosted := requireEffectiveChannel(t, effective, "beefapi")
	for _, model := range []string{"seedance-2.0", "seedance-2.0-fast", "seedance-2.0-mini", "seedance-2.5"} {
		profile := requireEffectiveProfile(t, hosted, model)
		if profile["capability"] != "video" || profile["protocol"] != "newapi" {
			t.Fatalf("hosted %s overlay = %#v", model, profile)
		}
	}
	fast := requireEffectiveProfile(t, hosted, "seedance-2.0-fast")
	if fast["displayName"] != "Seedance 2.0 Fast" {
		t.Fatalf("upstream display name was dropped: %#v", fast)
	}
	image := requireEffectiveProfile(t, hosted, "gpt-image-2")
	if image["capability"] != "image" || image["protocol"] != "openai-image" {
		t.Fatalf("hosted image profile rewritten: %#v", image)
	}

	custom := requireEffectiveChannel(t, effective, "custom-gateway")
	customFast := requireEffectiveProfile(t, custom, "seedance-2.0-fast")
	if customFast["capability"] != "text" || customFast["protocol"] != "chat-completion" {
		t.Fatalf("custom gateway capability was rewritten: %#v", customFast)
	}
	customImage := requireEffectiveProfile(t, custom, "gpt-image-2")
	if customImage["capability"] != "video" {
		t.Fatalf("custom image mislabel should stay a real type error: %#v", customImage)
	}
}

func staleHostedSeedanceConfig() []byte {
	return []byte(`{
		"imageModel":"beefapi::gpt-image-2",
		"videoModel":"beefapi::wan3.0-video",
		"channels":[
			{
				"id":"beefapi",
				"name":"BeefAPI",
				"baseUrl":"https://enterprise.beefapi.com",
				"enabled":true,
				"pinned":true,
				"models":["gpt-image-2","wan3.0-video","seedance-2.0","seedance-2.0-fast","seedance-2.0-mini","seedance-2.5"],
				"modelProfiles":[
					{"model":"gpt-image-2","capability":"image","protocol":"openai-image"},
					{"model":"wan3.0-video","capability":"video","protocol":"newapi-channel-2"},
					{"model":"seedance-2.0","capability":"text","protocol":"chat-completion"},
					{"model":"seedance-2.0-fast","displayName":"Seedance 2.0 Fast","capability":"text","protocol":"chat-completion"},
					{"model":"seedance-2.0-mini","capability":"text","protocol":"chat-completion"},
					{"model":"seedance-2.5","capability":"text","protocol":"chat-completion"}
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
}

func requireEffectiveProfile(t *testing.T, channel map[string]any, model string) map[string]any {
	t.Helper()
	profiles, _ := channel["modelProfiles"].([]any)
	for _, raw := range profiles {
		profile, _ := raw.(map[string]any)
		if profile["model"] == model {
			return profile
		}
	}
	t.Fatalf("missing profile %s in %#v", model, profiles)
	return nil
}
