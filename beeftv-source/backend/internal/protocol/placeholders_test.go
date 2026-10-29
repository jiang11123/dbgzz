package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProtocolPlaceholdersResolveOnlyApprovedResources(t *testing.T) {
	refs := []MediaRef{{StorageKey: "resource:allowed", DataURL: "data:image/png;base64,aW1hZ2U="}}
	requests := map[string]any{
		"chatCompletion": map[string]any{"messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": "resource:allowed"}}}}}},
		"claude":         map[string]any{"messages": []any{map[string]any{"content": []any{map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": "resource:allowed"}}}}}},
		"gemini":         map[string]any{"contents": []any{map[string]any{"parts": []any{map[string]any{"fileData": map[string]any{"fileUri": "resource:allowed", "mimeType": "image/png"}}}}}},
	}
	if err := ValidateProtocolPlaceholders(refs, requests); err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolveProtocolPlaceholders(refs, requests, true)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(resolved)
	text := string(b)
	for _, want := range []string{"data:image/png;base64,aW1hZ2U=", `"type":"base64"`, `"inlineData"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing protocol image: %s", want)
		}
	}
	original, _ := json.Marshal(requests)
	if strings.Contains(string(original), "base64") {
		t.Fatal("persistable protocol mutated")
	}
	requests["responses"] = map[string]any{"input": []any{map[string]any{"image_url": "resource:other"}}}
	if err := ValidateProtocolPlaceholders(refs, requests); err == nil {
		t.Fatal("unlisted resource allowed")
	}
}
