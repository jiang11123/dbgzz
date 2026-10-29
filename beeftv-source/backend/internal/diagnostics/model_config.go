package diagnostics

import (
	"encoding/json"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/kernel"
)

type rawModelConfig struct {
	ImageModel     string       `json:"imageModel"`
	VideoModel     string       `json:"videoModel"`
	TextModel      string       `json:"textModel"`
	AudioModel     string       `json:"audioModel"`
	AssistantModel string       `json:"assistantModel"`
	Channels       []rawChannel `json:"channels"`
}

type rawChannel struct {
	ID            string       `json:"id"`
	Name          string       `json:"name"`
	APIFormat     string       `json:"apiFormat"`
	InterfaceType string       `json:"interfaceType"`
	Scope         string       `json:"scope"`
	Enabled       *bool        `json:"enabled"`
	BaseURL       string       `json:"baseUrl"`
	Models        []string     `json:"models"`
	ModelProfiles []rawProfile `json:"modelProfiles"`
}

type rawProfile struct {
	Model      string `json:"model"`
	Capability string `json:"capability"`
	Protocol   string `json:"protocol"`
}

// buildModelConfigSummary decodes only the safe fields of the workspace model
// config. apiKey, secretKey and header values are never unmarshalled, and a
// base URL is reduced to its host, so the summary cannot leak a credential or
// a full URL even if the stored config carries one.
func buildModelConfigSummary(body []byte) *modelConfigSummary {
	if len(body) == 0 {
		return nil
	}
	var raw rawModelConfig
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil
	}
	summary := &modelConfigSummary{
		Defaults: defaultModelSelection{
			ImageModel:     safeConfigValue(raw.ImageModel),
			VideoModel:     safeConfigValue(raw.VideoModel),
			TextModel:      safeConfigValue(raw.TextModel),
			AudioModel:     safeConfigValue(raw.AudioModel),
			AssistantModel: safeConfigValue(raw.AssistantModel),
		},
	}
	for _, channel := range raw.Channels {
		profiles := make(map[string]rawProfile, len(channel.ModelProfiles))
		for _, profile := range channel.ModelProfiles {
			if model := strings.TrimSpace(profile.Model); model != "" {
				profiles[model] = profile
			}
		}
		entry := channelConfigSummary{
			ID:            safeConfigValue(channel.ID),
			Name:          safeConfigValue(channel.Name),
			APIFormat:     safeConfigValue(channel.APIFormat),
			InterfaceType: safeConfigValue(channel.InterfaceType),
			Scope:         safeConfigValue(channel.Scope),
			Enabled:       channel.Enabled == nil || *channel.Enabled,
			BaseURLHost:   hostOnly(channel.BaseURL),
			ModelCount:    len(channel.Models),
		}
		for _, model := range channel.Models {
			model = strings.TrimSpace(model)
			if model == "" {
				continue
			}
			item := modelConfigEntry{Model: safeConfigValue(model)}
			if profile, ok := profiles[model]; ok {
				item.Capability = safeConfigValue(profile.Capability)
				item.Protocol = safeConfigValue(profile.Protocol)
			}
			entry.Models = append(entry.Models, item)
		}
		summary.Channels = append(summary.Channels, entry)
	}
	return summary
}

func hostOnly(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" {
		return ""
	}
	return parsed.Hostname()
}

func safeConfigValue(value string) string {
	return kernel.TruncateRunes(strings.TrimSpace(value), 160)
}
