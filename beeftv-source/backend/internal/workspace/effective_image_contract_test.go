package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEffectiveConfigRepairsHostedHyImageWithoutRewritingCustomContract(t *testing.T) {
	dir := t.TempDir()
	raw := []byte(`{"channels":[{"id":"beefapi","baseUrl":"https://beeftv.app/v1","models":["hy-image-v3"],"modelProfiles":[{"model":"hy-image-v3","capability":"text","protocol":"chat-completion"}]},{"id":"custom","baseUrl":"https://studio.example","models":["hy-image-v3"],"modelProfiles":[{"model":"hy-image-v3","capability":"text","protocol":"chat-completion"}]}]}`)
	if err := os.WriteFile(filepath.Join(dir, LocalProviderConfigFile), raw, 0600); err != nil {
		t.Fatal(err)
	}
	store, _ := NewProviderConfig(dir)
	config, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	profile := requireEffectiveProfile(t, requireEffectiveChannel(t, config, "beefapi"), "hy-image-v3")
	if profile["protocol"] != "openai-image" || profile["capability"] != "image" {
		t.Fatalf("hosted profile: %#v", profile)
	}
	custom := requireEffectiveProfile(t, requireEffectiveChannel(t, config, "custom"), "hy-image-v3")
	if custom["protocol"] != "chat-completion" || custom["capability"] != "text" {
		t.Fatalf("custom profile: %#v", custom)
	}
}
