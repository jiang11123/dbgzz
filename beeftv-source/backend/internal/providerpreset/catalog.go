package providerpreset

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

//go:embed catalog/*.json
var catalogFiles embed.FS

type ModelProfile struct {
	Model            string          `json:"model"`
	Capability       string          `json:"capability"`
	Protocol         string          `json:"protocol"`
	CapabilityConfig json.RawMessage `json:"capabilityConfig"`
}

type ChannelPreset struct {
	ID              string         `json:"id"`
	DisplayName     string         `json:"displayName"`
	BaseURL         string         `json:"baseUrl"`
	CatalogProtocol string         `json:"catalogProtocol"`
	PresetVersion   int            `json:"presetVersion"`
	Pinned          bool           `json:"pinned"`
	Models          []ModelProfile `json:"models"`
	Metadata        map[string]any `json:"metadata,omitempty"`
}

var builtins = mustLoadCatalog()

func BuiltinChannels() []ChannelPreset {
	result := make([]ChannelPreset, len(builtins))
	for index := range builtins {
		result[index] = builtins[index].Clone()
	}
	return result
}

func BeefAPI() ChannelPreset {
	for _, preset := range builtins {
		if preset.ID == "beefapi" {
			return preset.Clone()
		}
	}
	panic("BeefAPI preset missing")
}

func (preset ChannelPreset) Model(name string) (ModelProfile, bool) {
	for _, profile := range preset.Models {
		if profile.Model == name {
			return profile, true
		}
	}
	return ModelProfile{}, false
}

func (preset ChannelPreset) Clone() ChannelPreset {
	body, err := json.Marshal(preset)
	if err != nil {
		panic(err)
	}
	var clone ChannelPreset
	if err := json.Unmarshal(body, &clone); err != nil {
		panic(err)
	}
	return clone
}

func Validate(preset ChannelPreset) error {
	if strings.TrimSpace(preset.ID) == "" || strings.TrimSpace(preset.DisplayName) == "" || strings.TrimSpace(preset.BaseURL) == "" {
		return errors.New("provider preset identity is incomplete")
	}
	if preset.PresetVersion < 1 {
		return errors.New("provider preset must be versioned")
	}
	if containsSecretField(preset.Metadata) {
		return errors.New("provider preset must not contain secrets")
	}
	seen := make(map[string]struct{}, len(preset.Models))
	for _, profile := range preset.Models {
		if strings.TrimSpace(profile.Model) == "" || strings.TrimSpace(profile.Capability) == "" {
			return errors.New("provider model identity is incomplete")
		}
		if _, ok := seen[profile.Model]; ok {
			return fmt.Errorf("duplicate provider model %q", profile.Model)
		}
		seen[profile.Model] = struct{}{}
		if !knownProtocol(profile.Protocol) {
			return fmt.Errorf("unknown provider protocol %q", profile.Protocol)
		}
		if len(profile.CapabilityConfig) == 0 || !json.Valid(profile.CapabilityConfig) {
			return fmt.Errorf("invalid capability config for %q", profile.Model)
		}
	}
	return nil
}

func mustLoadCatalog() []ChannelPreset {
	entries, err := catalogFiles.ReadDir("catalog")
	if err != nil {
		panic(err)
	}
	presets := make([]ChannelPreset, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		body, err := catalogFiles.ReadFile("catalog/" + entry.Name())
		if err != nil {
			panic(err)
		}
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.DisallowUnknownFields()
		var preset ChannelPreset
		if err := decoder.Decode(&preset); err != nil {
			panic(fmt.Errorf("decode provider preset %s: %w", entry.Name(), err))
		}
		if err := Validate(preset); err != nil {
			panic(fmt.Errorf("validate provider preset %s: %w", entry.Name(), err))
		}
		presets = append(presets, preset)
	}
	return presets
}

func knownProtocol(value string) bool {
	switch value {
	case "chat-completion", "openai-response", "claude-api", "openai-image", "openai-audio", "async-audio", "newapi", "newapi-channel-1", "newapi-channel-2", "xai-video":
		return true
	default:
		return false
	}
}

func containsSecretField(value any) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(key), "_", ""))
			if normalized == "apikey" || normalized == "token" || normalized == "secret" || strings.HasSuffix(normalized, "token") || strings.HasSuffix(normalized, "secret") {
				return true
			}
			if containsSecretField(child) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if containsSecretField(child) {
				return true
			}
		}
	}
	return false
}
