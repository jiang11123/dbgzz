package app

import (
	"encoding/json"
	"maps"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/workspace"
)

func portraitModel(id string) bool {
	return id == "seedance-2.0-portrait" || id == "seedance-2.5-portrait"
}

// Only saved provider state may authorize a portrait submission. Task input
// quotes and profiles are untrusted, including snapshots carried by retries.
func (s *Service) validatePortraitTaskQuote(input map[string]any) error {
	config, _ := input["config"].(map[string]any)
	modelID := strings.TrimSpace(stringValue(config["model"]))
	modelKey := strings.TrimSpace(stringValue(config["channelModelKey"]))
	if !portraitModel(modelID) && !portraitModel(modelKey) {
		return nil
	}
	unavailable := func() error {
		return BadAuthRequest("真人素材版当前模型或所选分辨率报价不可用，请刷新模型列表后重新选择")
	}
	if !portraitModel(modelID) || (modelKey != "" && modelKey != modelID) {
		return unavailable()
	}
	var request providerConfig
	body, err := json.Marshal(config)
	if err != nil || json.Unmarshal(body, &request) != nil {
		return unavailable()
	}
	store, err := workspace.NewProviderConfig(s.dataDir)
	if err != nil {
		return unavailable()
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		return unavailable()
	}
	var snapshot struct {
		Channels []struct {
			ID            string           `json:"id"`
			Enabled       bool             `json:"enabled"`
			BaseURL       string           `json:"baseUrl"`
			APIKey        string           `json:"apiKey"`
			SecretKey     string           `json:"secretKey"`
			Headers       []OutboundHeader `json:"headers"`
			Models        []string         `json:"models"`
			ModelProfiles []struct {
				Model        string          `json:"model"`
				VideoPricing json.RawMessage `json:"videoPricing"`
			} `json:"modelProfiles"`
		} `json:"channels"`
	}
	body, err = json.Marshal(effective.Config)
	if err != nil || json.Unmarshal(body, &snapshot) != nil {
		return unavailable()
	}
	managed := strings.TrimSpace(stringValue(config["credentialRef"])) == beefapi.CredentialRef
	resolution := strings.ToLower(strings.TrimSpace(request.VQuality))
	if resolution != "" {
		resolution = modelcatalog.NormalizeVideoResolution(resolution)
	}
	if resolution == "2160p" {
		resolution = "4k"
	}
	matches, quoted := 0, false
	for _, channel := range snapshot.Channels {
		if !channel.Enabled || (managed && channel.ID != beefapi.ChannelID) {
			continue
		}
		base, key := channel.BaseURL, channel.APIKey
		if channel.ID == beefapi.ChannelID {
			resolvedKey, resolvedBase, _, _, lookupErr := s.lookupBeefAPICredential()
			if lookupErr != nil {
				continue
			}
			base, key = resolvedBase, resolvedKey
		}
		if strings.TrimSpace(key) == "" || strings.TrimRight(strings.TrimSpace(base), "/") != strings.TrimRight(strings.TrimSpace(request.BaseURL), "/") || key != request.APIKey || channel.SecretKey != request.SecretKey || !portraitHeadersEqual(channel.Headers, request.Headers) {
			continue
		}
		matches++
		present := false
		for _, id := range channel.Models {
			present = present || id == modelID
		}
		if !present {
			continue
		}
		for _, profile := range channel.ModelProfiles {
			if profile.Model != modelID {
				continue
			}
			pricing, valid := beefapi.NormalizeCatalogVideoPricing(profile.VideoPricing)
			if valid && pricing["mode"] == "tokens" {
				rates := pricing["rates"].(map[string]any)
				_, quoted = rates[resolution]
			}
			break
		}
	}
	if matches != 1 || !quoted {
		return unavailable()
	}
	return nil
}

func portraitHeadersEqual(left, right []OutboundHeader) bool {
	a, errA := NormalizeOutboundHeaders(left)
	b, errB := NormalizeOutboundHeaders(right)
	if errA != nil || errB != nil {
		return false
	}
	values := func(headers []OutboundHeader) map[string]string {
		result := make(map[string]string, len(headers))
		for _, header := range headers {
			result[header.Name] = header.Value
		}
		return result
	}
	return maps.Equal(values(a), values(b))
}
