package workspace

import (
	"infinite-canvas/backend/internal/providerpreset"
	"testing"
)

func TestBrandPresetPreservesLegacyOriginAndReferences(t *testing.T) {
	for _, origin := range []string{"https://enterprise.beefapi.com", "https://beeftv.app"} {
		channel, err := presetChannelMap(providerpreset.BeefAPI(), map[string]any{"baseUrl": origin, "apiKey": "stored", "models": []any{"custom-model"}})
		if err != nil {
			t.Fatal(err)
		}
		if channel["baseUrl"] != origin || channel["name"] != "BeefTV" || channel["id"] != "beefapi" || channel["apiKey"] != "stored" {
			t.Fatalf("migration changed channel: %#v", channel)
		}
		if models := channel["models"].([]string); len(models) != 1 || models[0] != "custom-model" {
			t.Fatalf("models = %#v", models)
		}
	}
}
