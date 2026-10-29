package creation

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidatePreparedProtocolRejectsUnlistedResources(t *testing.T) {
	input, err := json.Marshal(map[string]any{
		"referenceImages": []any{map[string]any{"storageKey": "resource:allowed", "dataUrl": "data:image/png;base64,aW1hZ2U="}},
		"agentRequests": map[string]any{
			"chatCompletion": map[string]any{"messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": "resource:allowed"}}}}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := validatePreparedProtocol(string(input)); err != nil {
		t.Fatal(err)
	}
	hostile, err := json.Marshal(map[string]any{
		"referenceImages": []any{map[string]any{"storageKey": "resource:allowed"}},
		"agentRequests":   map[string]any{"responses": map[string]any{"input": []any{map[string]any{"image_url": "resource:other"}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := validatePreparedProtocol(string(hostile)); err == nil {
		t.Fatal("unlisted resource allowed")
	} else if !strings.Contains(err.Error(), "获准") {
		t.Fatalf("unexpected error = %v", err)
	}
}
