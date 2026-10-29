package modelcatalog

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

type LocalChannelModel struct {
	ChannelID                string
	BaseURL                  string
	Enabled                  bool
	Model                    string
	DisplayName              string
	Capability               string
	Protocol                 string
	CapabilityConfig         any
	VideoCapabilitiesVersion *string
	VideoPricing             json.RawMessage
}

func ParseLocalChannelModels(body []byte) []LocalChannelModel {
	if len(body) == 0 {
		return nil
	}
	var snapshot struct {
		Channels []struct {
			ID            string   `json:"id"`
			BaseURL       string   `json:"baseUrl"`
			Enabled       *bool    `json:"enabled"`
			Models        []string `json:"models"`
			ModelProfiles []struct {
				Model                    string          `json:"model"`
				DisplayName              string          `json:"displayName"`
				Capability               string          `json:"capability"`
				Protocol                 string          `json:"protocol"`
				CapabilityConfig         json.RawMessage `json:"capabilityConfig"`
				VideoCapabilitiesVersion *string         `json:"videoCapabilitiesVersion"`
				VideoPricing             json.RawMessage `json:"videoPricing"`
			} `json:"modelProfiles"`
		} `json:"channels"`
	}
	if json.Unmarshal(body, &snapshot) != nil {
		return nil
	}
	var result []LocalChannelModel
	for _, channel := range snapshot.Channels {
		if strings.TrimSpace(channel.ID) == "" {
			continue
		}
		enabled := channel.Enabled == nil || *channel.Enabled
		profiles := map[string]LocalChannelModel{}
		for _, profile := range channel.ModelProfiles {
			item := LocalChannelModel{
				ChannelID: channel.ID, BaseURL: channel.BaseURL, Enabled: enabled,
				Model: profile.Model, DisplayName: strings.TrimSpace(profile.DisplayName),
				Capability: profile.Capability, Protocol: profile.Protocol,
				VideoPricing:             profile.VideoPricing,
				VideoCapabilitiesVersion: profile.VideoCapabilitiesVersion,
			}
			if len(profile.CapabilityConfig) > 0 {
				var value any
				if json.Unmarshal(profile.CapabilityConfig, &value) == nil {
					item.CapabilityConfig = value
				}
			}
			profiles[profile.Model] = item
		}
		for _, name := range channel.Models {
			item := profiles[name]
			item.ChannelID = channel.ID
			item.BaseURL = channel.BaseURL
			item.Enabled = enabled
			item.Model = name
			if item.DisplayName == "" {
				item.DisplayName = name
			}
			result = append(result, item)
		}
	}
	return result
}

func FilterLocalChannelModels(items []LocalChannelModel, intent *ModelRequestIntent) []LocalChannelModel {
	result := make([]LocalChannelModel, 0, len(items))
	for _, item := range items {
		if !item.Enabled || item.Model == "" || !GenerationModeSupported(item.Capability) {
			continue
		}
		if intent != nil && (item.Protocol == "" || (normalizeCapability(intent.Capability) != "" && normalizeCapability(item.Capability) != normalizeCapability(intent.Capability))) {
			continue
		}
		if intent != nil {
			cm := localSnapshotChannelModel(item)
			matched, err := ChannelModelMatchesIntent(&cm, intent)
			if err != nil || !matched {
				continue
			}
		}
		result = append(result, item)
	}
	return result
}

func localSnapshotChannelModel(item LocalChannelModel) model.ChannelModel {
	cm := model.ChannelModel{ModelKey: item.Model, Capability: item.Capability, Protocol: model.ChannelInterfaceType(item.Protocol), Enabled: true}
	if item.CapabilityConfig != nil {
		if raw, err := json.Marshal(item.CapabilityConfig); err == nil {
			cm.CapabilityConfigJSON = string(raw)
		}
	} else if defaults := DefaultModelCapabilityConfigForModel(item.Protocol, item.Model); defaults != nil {
		if raw, err := json.Marshal(defaults); err == nil {
			cm.CapabilityConfigJSON = string(raw)
		}
	}
	return cm
}
