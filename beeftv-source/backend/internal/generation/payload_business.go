package generation

import (
	"encoding/json"
	"fmt"
	"strings"
)

func FailureDetails(payload map[string]any) (string, string) {
	candidates := make([]map[string]any, 0, 3)
	for _, key := range []string{"error", "data"} {
		if nested, ok := payload[key].(map[string]any); ok {
			candidates = append(candidates, nested)
		}
	}
	candidates = append(candidates, payload)
	code := ""
	message := ""
	for _, candidate := range candidates {
		if code == "" {
			code = normalizedUpstreamErrorCode(candidate["code"])
		}
		if message == "" {
			message = strings.TrimSpace(stringMapField(candidate, "message"))
			if message == "" {
				message = strings.TrimSpace(stringMapField(candidate, "msg"))
			}
		}
	}
	return code, truncateRunes(message, 500)
}

func ResponseBusinessFailure(responseBody []byte) (string, string, bool) {
	if len(responseBody) == 0 {
		return "", "", false
	}
	var payload map[string]any
	if json.Unmarshal(responseBody, &payload) != nil {
		return "", "", false
	}
	return PayloadBusinessFailure(payload)
}

func PayloadBusinessFailure(payload map[string]any) (string, string, bool) {
	if message, ok := payload["error"].(string); ok && strings.TrimSpace(message) != "" {
		return normalizedUpstreamErrorCode(payload["code"]), message, true
	}
	if errorValue, ok := payload["error"].(map[string]any); ok {
		code, message := FailureDetails(map[string]any{"error": errorValue})
		if code != "" || message != "" {
			return code, message, true
		}
	}
	if success, ok := payload["success"].(bool); ok && !success {
		code, message := FailureDetails(payload)
		return code, message, true
	}
	if !businessCodeFailed(payload["code"]) {
		return "", "", false
	}
	code, message := FailureDetails(payload)
	return code, message, true
}

func businessCodeFailed(value any) bool {
	code := strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
	switch code {
	case "", "0", "200", "success", "succeeded", "ok", "<nil>":
		return false
	default:
		return true
	}
}

func normalizedUpstreamErrorCode(value any) string {
	var code string
	switch current := value.(type) {
	case string:
		code = current
	case fmt.Stringer:
		code = current.String()
	case float64:
		if current != 0 {
			code = fmt.Sprintf("%g", current)
		}
	case int:
		if current != 0 {
			code = fmt.Sprintf("%d", current)
		}
	case int64:
		if current != 0 {
			code = fmt.Sprintf("%d", current)
		}
	}
	code = strings.TrimSpace(code)
	if code == "0" {
		return ""
	}
	return truncateRunes(code, 80)
}

func stringMapField(payload map[string]any, key string) string {
	value, ok := payload[key]
	if !ok || value == nil {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return text
}
