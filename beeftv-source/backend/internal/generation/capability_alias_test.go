package generation

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/modelcatalog"
)

func TestCapabilityTypesShareModelCatalogJSON(t *testing.T) {
	streaming := false
	src := modelcatalog.ModelCapabilityConfig{
		Version: 1,
		Text:    &modelcatalog.TextCapabilityConfig{Streaming: &streaming},
	}
	raw, err := json.Marshal(src)
	if err != nil {
		t.Fatal(err)
	}
	var dst ModelCapabilityConfig
	if err := json.Unmarshal(raw, &dst); err != nil {
		t.Fatal(err)
	}
	if dst.Text == nil || dst.Text.Streaming == nil || *dst.Text.Streaming {
		t.Fatalf("streaming field dropped: %+v", dst.Text)
	}
}
