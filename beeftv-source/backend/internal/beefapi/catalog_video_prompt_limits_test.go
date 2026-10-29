package beefapi

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/workspace"
)

func TestCatalogPersistsZeroAndUTF16PromptLimits(t *testing.T) {
	raw := json.RawMessage(strings.Replace(string(sampleCatalogVideo(t, 0, 0)), `"promptMaxChars": 8000`, `"promptMaxChars": 0, "promptMaxUtf16Units": 1000`, 1))
	video, ok := NormalizeCatalogVideoCapability(raw)
	if !ok {
		t.Fatal("zero character ceiling must not discard a valid video contract")
	}
	refs := video["references"].(map[string]any)
	if value, present := refs["promptMaxChars"]; !present || catalogNumber(value) != 0 || catalogNumber(refs["promptMaxUtf16Units"]) != 1000 {
		t.Fatalf("prompt units lost in catalog normalization: %#v", refs)
	}
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	models := []CatalogModel{{ID: "runway-gen4", SupportedEndpointTypes: []string{"openai-video"}, VideoCapabilities: raw, VideoCapabilitiesVersion: "utf16"}}
	if err := applyCatalog(store, models, "", "42", ""); err != nil {
		t.Fatal(err)
	}
	stored := catalogVideoRefs(t, catalogProfile(t, store, "runway-gen4"))
	if value, present := stored["promptMaxChars"]; !present || catalogNumber(value) != 0 || catalogNumber(stored["promptMaxUtf16Units"]) != 1000 {
		t.Fatalf("prompt units lost after persistence: %#v", stored)
	}
}

func TestCatalogPromptLimitsRejectInvalidValues(t *testing.T) {
	for _, field := range []string{"promptMaxChars", "promptMaxUtf16Units"} {
		for _, value := range []string{"-1", "1.5", "1000001", `"1000"`} {
			raw := strings.Replace(string(sampleCatalogVideo(t, 0, 0)), `"promptMaxChars": 8000`, `"`+field+`": `+value, 1)
			if _, ok := NormalizeCatalogVideoCapability(json.RawMessage(raw)); ok {
				t.Fatalf("invalid %s=%s accepted", field, value)
			}
		}
	}
}
