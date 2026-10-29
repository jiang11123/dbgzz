package modelcatalog

import "strings"

func normalizeVideoResolution(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "auto" || value == "medium" || value == "high" {
		return "720p"
	}
	if value == "low" {
		return "480p"
	}
	if strings.EqualFold(value, "4k") {
		return "2160p"
	}
	if strings.EqualFold(value, "2k") {
		return "1440p"
	}
	if strings.HasSuffix(value, "p") {
		return value
	}
	return value + "p"
}

func videoResolutionNameRequest(profile *VideoCapabilityConfig, value string) string {
	requested := strings.ToLower(strings.TrimSpace(value))
	if requested == "" || requested == "auto" || requested == "default" || requested == "medium" || requested == "high" {
		return ""
	}
	if profile == nil {
		return ""
	}
	if len(profile.Resolutions) == 0 {
		return ""
	}
	candidates := []string{requested, strings.ToLower(normalizeVideoResolution(requested))}
	if requested == "4k" {
		candidates = append(candidates, "2160p")
	}
	if requested == "2160" || requested == "2160p" {
		candidates = append(candidates, "4k")
	}
	if requested == "1440" || requested == "1440p" {
		candidates = append(candidates, "2k")
	}
	for _, supported := range profile.Resolutions {
		for _, candidate := range candidates {
			if strings.EqualFold(strings.TrimSpace(supported), candidate) {
				return strings.TrimSpace(supported)
			}
		}
	}
	return ""
}

func isAutomaticVideoResolution(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "auto", "default", "medium", "high":
		return true
	default:
		return false
	}
}

func VideoResolutionNameRequest(profile *VideoCapabilityConfig, value string) string {
	return videoResolutionNameRequest(profile, value)
}

func IsAutomaticVideoResolution(value string) bool {
	return isAutomaticVideoResolution(value)
}

func NormalizeVideoResolution(value string) string {
	return normalizeVideoResolution(value)
}
