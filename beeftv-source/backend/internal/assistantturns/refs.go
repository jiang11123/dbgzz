package assistantturns

import (
	"encoding/json"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/canvas"
)

// AssociatedReferences parses media asset and generation-batch task IDs from
// a real canvas document. It reuses canvas.MediaAssetReferences.
func AssociatedReferences(raw json.RawMessage) ([]string, []string) {
	assets := []string{}
	if references, err := canvas.MediaAssetReferences(raw); err == nil {
		for _, reference := range references {
			if id := strings.TrimSpace(reference.AssetID); id != "" {
				assets = append(assets, id)
			}
		}
	}
	tasks := []string{}
	var payload struct {
		Nodes []struct {
			Metadata struct {
				GenerationBatch struct {
					TaskID       string `json:"taskId"`
					Continuation struct {
						TaskID string `json:"taskId"`
					} `json:"agentGenerationContinuation"`
				} `json:"generationBatch"`
			} `json:"metadata"`
		} `json:"nodes"`
	}
	if json.Unmarshal(raw, &payload) == nil {
		for _, node := range payload.Nodes {
			if id := strings.TrimSpace(node.Metadata.GenerationBatch.TaskID); id != "" {
				tasks = append(tasks, id)
			}
			if id := strings.TrimSpace(node.Metadata.GenerationBatch.Continuation.TaskID); id != "" {
				tasks = append(tasks, id)
			}
		}
	}
	return uniqueSorted(assets), uniqueSorted(tasks)
}

func uniqueSorted(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	sort.Strings(out)
	return out
}

func DocumentRevision(doc map[string]any) int64 {
	switch value := doc["revision"].(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case int:
		return int64(value)
	case json.Number:
		if parsed, err := value.Int64(); err == nil {
			return parsed
		}
	}
	return 0
}

func jsonWholeNumber(value any) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		if typed != float64(int64(typed)) {
			return 0, false
		}
		return int64(typed), true
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func docItems(value any) []map[string]any {
	items, _ := value.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if object, ok := item.(map[string]any); ok {
			out = append(out, object)
		}
	}
	return out
}
