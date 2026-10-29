package workspace

import (
	"encoding/json"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/providerpreset"
)

const providerStateSchemaVersion = 1

type ConfigHealth string

const (
	ConfigHealthReady     ConfigHealth = "ready"
	ConfigHealthDefault   ConfigHealth = "default"
	ConfigHealthMigrated  ConfigHealth = "migrated"
	ConfigHealthRecovered ConfigHealth = "recovered"
)

type ProviderStateDocument struct {
	SchemaVersion                 int            `json:"schemaVersion"`
	Revision                      int64          `json:"revision"`
	PresetVersions                map[string]int `json:"presetVersions"`
	Config                        map[string]any `json:"config"`
	AssistantDefaultAuthorization string         `json:"assistantDefaultAuthorization,omitempty"`
}

type EffectiveModelConfig struct {
	SchemaVersion  int            `json:"schemaVersion"`
	Revision       int64          `json:"revision"`
	PresetVersions map[string]int `json:"presetVersions"`
	Config         map[string]any `json:"config"`
}

func newProviderState(config map[string]any, revision int64) ProviderStateDocument {
	return ProviderStateDocument{
		SchemaVersion:  providerStateSchemaVersion,
		Revision:       revision,
		PresetVersions: builtinPresetVersions(),
		Config:         config,
	}
}

func effectiveProviderState(document ProviderStateDocument) (EffectiveModelConfig, error) {
	config, err := mergeBuiltinProviderPresets(document.Config)
	if err != nil {
		return EffectiveModelConfig{}, err
	}
	return EffectiveModelConfig{
		SchemaVersion:  providerStateSchemaVersion,
		Revision:       document.Revision,
		PresetVersions: builtinPresetVersions(),
		Config:         config,
	}, nil
}

func mergeBuiltinProviderPresets(config map[string]any) (map[string]any, error) {
	result, err := cloneMap(config)
	if err != nil {
		return nil, err
	}
	channels := map[string]map[string]any{}
	order := make([]string, 0)
	if rawChannels, ok := result["channels"].([]any); ok {
		for _, raw := range rawChannels {
			channel, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			id, _ := channel["id"].(string)
			if id == "" {
				continue
			}
			channels[id] = channel
			order = append(order, id)
		}
	}

	for _, preset := range providerpreset.BuiltinChannels() {
		local := channels[preset.ID]
		merged, err := presetChannelMap(preset, local)
		if err != nil {
			return nil, err
		}
		channels[preset.ID] = merged
		if !containsString(order, preset.ID) {
			order = append([]string{preset.ID}, order...)
		}
	}

	mergedChannels := make([]any, 0, len(order))
	for _, id := range order {
		if channel := channels[id]; channel != nil {
			mergedChannels = append(mergedChannels, overlayHostedBeefAPIMediaProfiles(channel))
		}
	}
	result["channels"] = mergedChannels
	return result, nil
}

func overlayHostedBeefAPIMediaProfiles(channel map[string]any) map[string]any {
	baseURL, _ := channel["baseUrl"].(string)
	profiles, _ := channel["modelProfiles"].([]any)
	seen := map[string]bool{}
	next := make([]any, 0, len(profiles))
	for _, raw := range profiles {
		profile, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		model, _ := profile["model"].(string)
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		seen[model] = true
		if capability, protocol, ok := hostedBeefAPIMediaProfile(baseURL, model); ok {
			overlaid := cloneProfileMap(profile)
			overlaid["capability"] = capability
			overlaid["protocol"] = protocol
			next = append(next, overlaid)
			continue
		}
		next = append(next, profile)
	}
	for _, model := range channelModelIDs(channel["models"]) {
		if seen[model] {
			continue
		}
		capability, protocol, ok := hostedBeefAPIMediaProfile(baseURL, model)
		if !ok {
			continue
		}
		next = append(next, map[string]any{"model": model, "capability": capability, "protocol": protocol})
	}
	channel["modelProfiles"] = next
	return channel
}

func hostedBeefAPIMediaProfile(baseURL, model string) (string, string, bool) {
	if providerpreset.IsBeefAPIEndpoint(baseURL) {
		if contract, ok := providerpreset.BeefAPIImageContract(model); ok {
			return "image", contract.Protocol, true
		}
	}
	return providerpreset.HostedBeefAPIVideoProfile(baseURL, model)
}

func cloneProfileMap(profile map[string]any) map[string]any {
	cloned := make(map[string]any, len(profile))
	for key, value := range profile {
		cloned[key] = value
	}
	return cloned
}

func channelModelIDs(value any) []string {
	switch items := value.(type) {
	case []string:
		ids := make([]string, 0, len(items))
		for _, item := range items {
			if model := strings.TrimSpace(item); model != "" {
				ids = append(ids, model)
			}
		}
		return ids
	case []any:
		ids := make([]string, 0, len(items))
		for _, item := range items {
			model, _ := item.(string)
			if model = strings.TrimSpace(model); model != "" {
				ids = append(ids, model)
			}
		}
		return ids
	default:
		return nil
	}
}

func presetChannelMap(preset providerpreset.ChannelPreset, local map[string]any) (map[string]any, error) {
	models := make([]string, 0, len(preset.Models))
	profiles := make([]any, 0, len(preset.Models))
	presetModels := make(map[string]struct{}, len(preset.Models))
	for _, profile := range preset.Models {
		models = append(models, profile.Model)
		presetModels[profile.Model] = struct{}{}
		var capabilityConfig any
		if err := json.Unmarshal(profile.CapabilityConfig, &capabilityConfig); err != nil {
			return nil, fmt.Errorf("decode %s capability config: %w", profile.Model, err)
		}
		profiles = append(profiles, map[string]any{
			"model": profile.Model, "capability": profile.Capability,
			"protocol": profile.Protocol, "capabilityConfig": capabilityConfig,
		})
	}
	if localModels, ok := local["models"].([]any); ok {
		for _, value := range localModels {
			model, ok := value.(string)
			if !ok || model == "" {
				continue
			}
			if _, managed := presetModels[model]; !managed && !containsString(models, model) {
				models = append(models, model)
			}
		}
	}
	if localProfiles, ok := local["modelProfiles"].([]any); ok {
		for _, value := range localProfiles {
			profile, ok := value.(map[string]any)
			if !ok {
				continue
			}
			model, _ := profile["model"].(string)
			if _, managed := presetModels[model]; model != "" && !managed {
				profiles = append(profiles, profile)
			}
		}
	}
	result := map[string]any{
		"id": preset.ID, "name": preset.DisplayName, "baseUrl": preset.BaseURL,
		"apiFormat": preset.CatalogProtocol, "scope": "user", "pinned": preset.Pinned,
		"presetVersion": preset.PresetVersion, "models": models, "modelProfiles": profiles,
		"apiKey": "", "secretKey": "", "headers": []any{}, "enabled": true,
	}
	for _, key := range []string{"apiKey", "secretKey", "headers", "enabled"} {
		if value, ok := local[key]; ok {
			result[key] = value
		}
	}
	if preset.ID == "beefapi" {
		base, _ := local["baseUrl"].(string)
		if base == "https://enterprise.beefapi.com" || base == "https://beeftv.app" {
			result["baseUrl"] = base
		} else if key, _ := local["apiKey"].(string); base == "" && key != "" {
			// Pre-brand manual credentials without an origin were issued by BeefAPI.
			result["baseUrl"] = "https://enterprise.beefapi.com"
		}
	}
	return result, nil
}

func builtinPresetVersions() map[string]int {
	versions := make(map[string]int)
	for _, preset := range providerpreset.BuiltinChannels() {
		versions[preset.ID] = preset.PresetVersion
	}
	return versions
}

func cloneMap(value map[string]any) (map[string]any, error) {
	if value == nil {
		return map[string]any{}, nil
	}
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var clone map[string]any
	if err := json.Unmarshal(body, &clone); err != nil {
		return nil, err
	}
	return clone, nil
}

func containsString(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
