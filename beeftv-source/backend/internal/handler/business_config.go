package handler

import "strings"

func externalSecretField(k string) bool {
	n := strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(k))
	return (strings.Contains(n, "apikey") && !strings.HasPrefix(n, "has")) || strings.Contains(n, "secret") || strings.Contains(n, "password") || n == "token" || n == "authorization" || n == "cookie" || n == "accesskey" || n == "privatekey" || n == "headers" || n == "customheaders" || n == "devicecode"
}

// External discovery never returns reusable provider credentials, including
// user-owned custom channels rather than only the managed BeefAPI channel.
func redactExternalConfig(config map[string]any) map[string]any {
	if config == nil {
		return nil
	}
	var redact func(any) any
	redact = func(value any) any {
		switch v := value.(type) {
		case map[string]any:
			out := make(map[string]any, len(v))
			for k, x := range v {
				if externalSecretField(k) {
					out[k] = ""
					continue
				}
				out[k] = redact(x)
			}
			return out
		case []any:
			out := make([]any, len(v))
			for i, x := range v {
				out[i] = redact(x)
			}
			return out
		default:
			return v
		}
	}
	return redact(config).(map[string]any)
}

func preserveExternalConfigSecrets(incoming, existing map[string]any) {
	for key, old := range existing {
		if externalSecretField(key) {
			value, present := incoming[key]
			if !present || value == "" || value == nil {
				incoming[key] = old
			}
			continue
		}
		switch oldValue := old.(type) {
		case map[string]any:
			if next, ok := incoming[key].(map[string]any); ok {
				preserveExternalConfigSecrets(next, oldValue)
			}
		case []any:
			next, _ := incoming[key].([]any)
			for _, item := range next {
				n, ok := item.(map[string]any)
				if !ok {
					continue
				}
				id, _ := n["id"].(string)
				if id == "" {
					continue
				}
				for _, oldItem := range oldValue {
					o, ok := oldItem.(map[string]any)
					if ok && o["id"] == id {
						preserveExternalConfigSecrets(n, o)
						break
					}
				}
			}
		}
	}
}
