package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeTaskInputStillAllowsSecretProtection(t *testing.T) {
	input, err := normalizeTaskInput(map[string]any{
		"config": providerConfig{BaseURL: "https://example.com", APIKey: "private-key", Model: "text-model"},
	})
	if err != nil {
		t.Fatal(err)
	}
	config, ok := input["config"].(map[string]any)
	if !ok || config["apiKey"] != "private-key" {
		t.Fatalf("normalized config = %#v", input["config"])
	}
	svc := &Service{dataDir: t.TempDir()}
	if err := svc.protectTaskSecrets(input); err != nil {
		t.Fatal(err)
	}
	protected, _ := config["apiKey"].(string)
	if protected == "private-key" || !strings.HasPrefix(protected, encryptedSettingPrefix) {
		t.Fatalf("protected apiKey = %q", protected)
	}
}

func TestTaskCustomHeadersAreEncryptedAndRestored(t *testing.T) {
	svc := &Service{dataDir: t.TempDir()}
	input := map[string]any{"config": map[string]any{"apiKey": "private-api", "headers": []any{map[string]any{"name": "X-Key", "value": "private-header"}}}}
	if err := svc.protectTaskSecrets(input); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(input)
	if strings.Contains(string(body), "private-") {
		t.Fatal("task secret leaked")
	}
	if err := svc.decryptTaskSecrets(input); err != nil {
		t.Fatal(err)
	}
	body, _ = json.Marshal(input)
	if !strings.Contains(string(body), "private-header") || !strings.Contains(string(body), "private-api") {
		t.Fatal("task secrets not restored")
	}
}

func TestTaskInputRejectsInlineMedia(t *testing.T) {
	input, err := normalizeTaskInput(map[string]any{
		"referenceImages": []providerMedia{{DataURL: testReferenceImageDataURL}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !containsInlineMediaDataURL(input) {
		t.Fatal("containsInlineMediaDataURL() = false")
	}
}
