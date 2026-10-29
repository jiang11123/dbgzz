package generation

import "net/http"

func ApplyAuth(req *http.Request, config Config) {
	if req == nil {
		return
	}
	if config.APIFormat == "claude" {
		req.Header.Set("x-api-key", config.APIKey)
		req.Header.Set("anthropic-version", "2023-06-01")
		return
	}
	if config.APIFormat == "gemini" {
		req.Header.Set("x-goog-api-key", config.APIKey)
		return
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
}
