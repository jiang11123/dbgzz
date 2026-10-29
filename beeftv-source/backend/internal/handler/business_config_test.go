package handler

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestExternalModelConfigRedactionRoundTripAndCAS(t *testing.T) {
	router, store := newModelConfigTestRouter(t)
	call := func(method string, body any) *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		r := httptest.NewRequest(method, "/api/workspace/model-config", bytes.NewReader(data))
		r.Header.Set("Content-Type", "application/json")
		r = WithExternalBusinessPrincipal(r, false)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	config := map[string]any{"channels": []any{map[string]any{"id": "custom", "name": "Custom", "baseUrl": "https://example.invalid/v1", "apiKey": "test-custom-key", "secretKey": "test-custom-secret", "headers": map[string]any{"Authorization": "Bearer test-only-header"}, "enabled": true}}}
	first := call("PUT", map[string]any{"config": config, "expectedRevision": 0})
	if first.Code != 200 {
		t.Fatal(first.Code, first.Body.String())
	}
	get := call("GET", nil)
	if get.Code != 200 {
		t.Fatal(get.Code, get.Body.String())
	}
	for _, s := range []string{"test-custom-key", "test-custom-secret", "test-only-header"} {
		if bytes.Contains(get.Body.Bytes(), []byte(s)) {
			t.Fatal("custom credential leaked")
		}
	}
	redacted := modelConfigResponseData(t, get)
	roundTrip := call("PUT", map[string]any{"config": redacted["config"], "expectedRevision": redacted["revision"]})
	if roundTrip.Code != 200 {
		t.Fatal(roundTrip.Code, roundTrip.Body.String())
	}
	stored, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	channels := stored.Config["channels"].([]any)
	found := false
	for _, value := range channels {
		channel := value.(map[string]any)
		if channel["id"] == "custom" {
			found = true
			if channel["apiKey"] != "test-custom-key" || channel["secretKey"] != "test-custom-secret" {
				t.Fatal("redacted roundtrip erased credentials")
			}
		}
	}
	if !found {
		t.Fatal("custom channel removed")
	}
	if stale := call("PUT", map[string]any{"config": redacted["config"], "expectedRevision": 0}); stale.Code != 409 {
		t.Fatal("stale external configuration accepted", stale.Code)
	}
	if noCAS := call("PUT", map[string]any{"config": redacted["config"]}); noCAS.Code != 400 {
		t.Fatal("external configuration bypassed CAS")
	}
}
