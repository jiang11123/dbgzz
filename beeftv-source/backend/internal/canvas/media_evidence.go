package canvas

import "strings"

// NodeHasMedia reports references, never ordinary prompt or result text.
func NodeHasMedia(node map[string]any) bool {
	metadata, _ := node["metadata"].(map[string]any)
	for _, fields := range []map[string]any{node, metadata} {
		for _, key := range []string{"storageKey", "assetId", "resourceId"} {
			if value, ok := fields[key].(string); ok && strings.TrimSpace(value) != "" {
				return true
			}
		}
		for _, key := range []string{"content", "url", "dataUrl"} {
			value, _ := fields[key].(string)
			value = strings.ToLower(strings.TrimSpace(value))
			for _, prefix := range []string{"http:", "https:", "data:", "blob:", "resource:", "/api/resources/"} {
				if strings.HasPrefix(value, prefix) {
					return true
				}
			}
		}
	}
	return false
}
