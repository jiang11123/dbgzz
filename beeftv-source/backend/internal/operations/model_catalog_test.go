package operations_test

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/operations"
)

func TestModelCatalogUsesPublicProjectionAndRejectsExtraParameters(t *testing.T) {
	h := newHarness(t)
	result, err := h.execute(t, operations.ExternalCaller(false), "model.catalog", "", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(result.Result)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"apiKey"`, `"secretKey"`, `"token"`, `"baseUrl"`} {
		if strings.Contains(string(raw), field) {
			t.Fatalf("public catalog exposed %s", field)
		}
	}
	if _, err := h.execute(t, operations.ExternalCaller(false), "model.catalog", "", map[string]any{"userId": "other"}); err == nil {
		t.Fatal("model supplied owner accepted")
	}
}
