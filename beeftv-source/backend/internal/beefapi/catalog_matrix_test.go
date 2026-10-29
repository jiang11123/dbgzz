package beefapi

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestFetchedBeefAPICatalogEveryModelHasTheCorrectGenerationFamily(t *testing.T) {
	raw, err := os.ReadFile("../../../fixtures/model-catalog/beefapi-20261013.json")
	if err != nil {
		t.Fatal(err)
	}
	var models []struct {
		ID        string   `json:"id"`
		Endpoints []string `json:"supported_endpoint_types"`
	}
	if err := json.Unmarshal(raw, &models); err != nil {
		t.Fatal(err)
	}
	if len(models) != 47 {
		t.Fatalf("fixture size %d", len(models))
	}
	for _, model := range models {
		want := "text"
		switch {
		case model.ID == "hy-asr-3.0-preview":
			want = ""
		case strings.Contains(model.ID, "image"):
			want = "image"
		case strings.Contains(model.ID, "speech") || strings.Contains(model.ID, "music"):
			want = "audio"
		case strings.Contains(model.ID, "video") || strings.HasPrefix(model.ID, "seedance-") || model.ID == "minimax-h3-max-turbo":
			want = "video"
		}
		capability, protocol := catalogCapabilityAndProtocol(CatalogModel{ID: model.ID, SupportedEndpointTypes: model.Endpoints})
		if capability != want || (want != "" && protocol == "") {
			t.Fatalf("%s: capability=%s protocol=%s expected=%s", model.ID, capability, protocol, want)
		}
	}
}
