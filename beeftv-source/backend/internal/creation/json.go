package creation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/kernel"
)

const maxJSONBytes = 1 << 20

func Hash(value any) string {
	b, _ := json.Marshal(value)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func MergeMaps(left, right map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range left {
		out[key] = value
	}
	for key, value := range right {
		out[key] = value
	}
	return out
}

func stringValue(value any) string {
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "<nil>" {
		return ""
	}
	return text
}

func ValidateJSON(value any) error {
	b, err := json.Marshal(value)
	if err != nil || len(b) > maxJSONBytes {
		return kernel.BadAuthRequest(msgJSONLimit)
	}
	var decoded any
	_ = json.Unmarshal(b, &decoded)
	if !visitJSONSecrets(decoded) {
		return kernel.BadAuthRequest(msgSecretsInRecord)
	}
	return nil
}

func visitJSONSecrets(v any) bool {
	switch item := v.(type) {
	case map[string]any:
		for key, child := range item {
			switch strings.ToLower(key) {
			case "apikey", "secretkey", "authorization", "cookie", "headers", "baseurl", "token", "accesstoken", "refresh_token":
				if child != nil && child != "" {
					return false
				}
			}
			if !visitJSONSecrets(child) {
				return false
			}
		}
	case []any:
		for _, child := range item {
			if !visitJSONSecrets(child) {
				return false
			}
		}
	case string:
		if strings.HasPrefix(item, "data:") || strings.Contains(item, "X-Amz-Signature=") || strings.Contains(item, "X-Tos-Signature=") {
			return false
		}
	}
	return true
}

func cloneJSON[T any](value T) (T, error) {
	var out T
	b, err := json.Marshal(value)
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(b, &out)
	return out, err
}

func parseDocument(raw string) (map[string]any, error) {
	var doc map[string]any
	err := json.Unmarshal([]byte(raw), &doc)
	if doc == nil && err == nil {
		return nil, kernel.BadAuthRequest("画布文档格式无效")
	}
	return doc, err
}

func documentObjects(value any) (map[string]map[string]any, error) {
	list, ok := value.([]any)
	if !ok {
		return nil, kernel.BadAuthRequest("画布节点或连线格式无效")
	}
	out := map[string]map[string]any{}
	for _, raw := range list {
		item, ok := raw.(map[string]any)
		if !ok {
			return nil, kernel.BadAuthRequest("画布对象格式无效")
		}
		id := stringValue(item["id"])
		if id == "" || out[id] != nil {
			return nil, kernel.BadAuthRequest("画布对象 ID 缺失或重复")
		}
		out[id] = item
	}
	return out, nil
}

func executionJSON(execution Execution) (string, error) {
	raw, err := json.Marshal(execution)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
