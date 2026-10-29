package generation

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// ValidateImageArtifact rejects error documents returned with a successful HTTP
// status, regardless of whether bytes arrived during generation or later delivery.
func ValidateImageArtifact(data []byte, mimeType string) error {
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	mimeType = strings.ToLower(NormalizedMediaMIMEType(mimeType, data))
	if len(data) == 0 || strings.Contains(detected, "json") || strings.HasPrefix(detected, "text/") || !strings.HasPrefix(mimeType, "image/") {
		return fmt.Errorf("图片结果无效：%s", defaultString(detected, mimeType))
	}
	return nil
}

// Durable tasks save public artifact references before delivery, so a failed GET
// cannot replay a paid create. Standalone calls and authenticated provider routes
// still materialize here; the delivery worker does not receive provider secrets.
func deferImageArtifactDownload(ctx context.Context, config Config, rawURL string) bool {
	if TaskExecutionID(ctx) == "" {
		return false
	}
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return false
	}
	if !SameProviderOrigin(config.BaseURL, ProviderDownloadURL(config.BaseURL, rawURL)) {
		return true
	}
	// BeefAPI's signed image proxy authorizes with its result token, not the
	// account key. Preserve the returned URL rather than rewriting its origin.
	return parsed.Scheme == "https" && isBeefAPIHost(parsed.Hostname()) && parsed.Path == "/v1/images/proxy" && parsed.Query().Get("t") != ""
}
