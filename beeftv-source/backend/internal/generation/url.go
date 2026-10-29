package generation

import (
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/model"
)

func APIURL(baseURL string, path string) string {
	return apiURLWithDefaultPrefix(baseURL, path, "/v1")
}

func ChannelAPIURL(baseURL string, path string) string {
	return APIURL(baseURL, path)
}

// ChannelAPIURLForProtocol 把协议默认版本收敛在传输边界：Gemini 默认 v1beta，
// OpenAI 兼容协议默认 v1；baseURL 或 path 中显式出现的版本始终优先。
func ChannelAPIURLForProtocol(baseURL string, path string, interfaceType model.ChannelInterfaceType) string {
	if interfaceType == model.ChannelInterfaceAgnesVideo && strings.HasPrefix(strings.TrimSpace(path), "/agnesapi") {
		base, err := url.Parse(strings.TrimSpace(baseURL))
		requestPath, pathErr := url.Parse(strings.TrimSpace(path))
		if err == nil && pathErr == nil && base.Scheme != "" && base.Host != "" && strings.HasPrefix(requestPath.Path, "/") {
			base.Path = requestPath.Path
			base.RawPath = requestPath.RawPath
			base.RawQuery = requestPath.RawQuery
			base.Fragment = ""
			return base.String()
		}
	}
	defaultPrefix := "/v1"
	if interfaceType == model.ChannelInterfaceGeminiVeo || interfaceType == model.ChannelInterfaceGeminiImage {
		defaultPrefix = "/v1beta"
	}
	return apiURLWithDefaultPrefix(baseURL, path, defaultPrefix)
}

var channelAPIPrefixes = []string{"/api/plan/v3", "/api/v3", "/api/v1", "/v1beta", "/v1", "/v2", "/v3"}

func apiURLWithDefaultPrefix(baseURL string, path string, defaultPrefix string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	requestPath := strings.TrimSpace(path)
	if requestPath == "" {
		return base
	}
	if !strings.HasPrefix(requestPath, "/") {
		requestPath = "/" + requestPath
	}

	requestPrefix := requestAPIPathPrefix(requestPath)
	basePrefix := baseAPIPathPrefix(base)
	if requestPrefix != "" {
		if basePrefix == requestPrefix {
			return base + strings.TrimPrefix(requestPath, requestPrefix)
		}
		return strings.TrimSuffix(base, basePrefix) + requestPath
	}
	if basePrefix != "" {
		return base + requestPath
	}
	return base + defaultPrefix + requestPath
}

func requestAPIPathPrefix(value string) string {
	lower := strings.ToLower(value)
	for _, prefix := range channelAPIPrefixes {
		if lower == prefix || strings.HasPrefix(lower, prefix+"/") || strings.HasPrefix(lower, prefix+"?") || strings.HasPrefix(lower, prefix+"#") {
			return prefix
		}
	}
	return ""
}

func baseAPIPathPrefix(value string) string {
	lower := strings.ToLower(strings.TrimRight(value, "/"))
	for _, prefix := range channelAPIPrefixes {
		if lower == prefix || strings.HasSuffix(lower, prefix) {
			return prefix
		}
	}
	return ""
}

func GeminiURL(baseURL string, path string) string {
	return apiURLWithDefaultPrefix(baseURL, path, "/v1beta")
}

func ProviderDownloadURL(baseURL string, rawURL string) string {
	base, baseErr := url.Parse(strings.TrimSpace(baseURL))
	target, targetErr := url.Parse(strings.TrimSpace(rawURL))
	// A completed task may return a root-relative authenticated media endpoint.
	// Resolve only a single-slash path, never a scheme-relative external host or
	// an arbitrary status string, and leave network validation to the transport.
	if baseErr == nil && targetErr == nil && base.Host != "" && base.User == nil && (base.Scheme == "https" || base.Scheme == "http") && target.Scheme == "" && target.Host == "" && strings.HasPrefix(target.Path, "/") && !strings.HasPrefix(strings.TrimSpace(rawURL), "//") && target.Fragment == "" && !strings.Contains(target.Path, "\\") {
		return base.ResolveReference(target).String()
	}
	if baseErr != nil || targetErr != nil || !strings.EqualFold(base.Scheme, "https") || !strings.EqualFold(target.Scheme, "https") {
		return rawURL
	}
	if isBeefAPIHost(base.Hostname()) && isBeefAPIHost(target.Hostname()) {
		target.Scheme = base.Scheme
		target.Host = base.Host
		return target.String()
	}
	return rawURL
}

func IsBeefAPIHost(host string) bool {
	return isBeefAPIHost(host)
}

func isBeefAPIHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return host == "beeftv.app" || host == "beefapi.com" || strings.HasSuffix(host, ".beefapi.com")
}

func SameProviderOrigin(baseURL string, rawURL string) bool {
	base, baseErr := url.Parse(strings.TrimSpace(baseURL))
	target, targetErr := url.Parse(strings.TrimSpace(rawURL))
	if baseErr != nil || targetErr != nil || base.Scheme == "" || base.Host == "" || target.Scheme == "" || target.Host == "" {
		return false
	}
	return strings.EqualFold(base.Scheme, target.Scheme) && strings.EqualFold(base.Host, target.Host)
}
