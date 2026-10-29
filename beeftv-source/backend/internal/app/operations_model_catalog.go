package app

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/providerpreset"
)

// Desktop execution uses its provider snapshot, not hosted database channels.
// The public sanitizer excludes execution addresses, headers and credentials.
func (s *operationSession) AgentModelCatalog() (*modelcatalog.CatalogResponse, error) {
	if !s.service.IsLocalMode() {
		return s.service.ModelCatalog(nil)
	}
	body, err := s.service.ReadLocalModelConfig()
	if err != nil {
		return nil, err
	}
	var snapshot struct {
		Channels []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"channels"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &snapshot); err != nil {
			return nil, err
		}
	}
	names := map[string]string{}
	for _, channel := range snapshot.Channels {
		names[channel.ID] = strings.TrimSpace(channel.Name)
	}
	channels := []modelcatalog.PublicChannelCatalog{}
	indexes := map[string]int{}
	for _, item := range modelcatalog.ParseLocalChannelModels(body) {
		if !item.Enabled || strings.TrimSpace(item.Model) == "" {
			continue
		}
		cm := model.ChannelModel{ID: item.Model, ModelKey: item.Model, DisplayName: item.DisplayName, Capability: item.Capability, Protocol: model.ChannelInterfaceType(item.Protocol), Enabled: true}
		if item.Capability == "video" {
			if _, protocol, ok := providerpreset.HostedBeefAPIVideoProfile(item.BaseURL, item.Model); ok {
				cm.Protocol = model.ChannelInterfaceType(protocol)
			}
		}
		capabilityConfig := item.CapabilityConfig
		if capabilityConfig == nil {
			capabilityConfig = modelcatalog.DefaultModelCapabilityConfigForModel(string(cm.Protocol), item.Model)
		}
		if capabilityConfig != nil {
			config, err := json.Marshal(capabilityConfig)
			if err != nil {
				return nil, err
			}
			if item.Capability == "video" {
				parsed, err := modelcatalog.DecodeModelCapabilityConfig(string(config))
				if err != nil {
					continue
				}
				config, err = json.Marshal(modelcatalog.ApplyLocalVideoContract(item, parsed))
				if err != nil {
					return nil, err
				}
			}
			cm.CapabilityConfigJSON = string(config)
		}
		public, err := modelcatalog.SanitizeChannelModel(&cm)
		if err != nil {
			continue
		}
		if item.Capability == "video" {
			// Only the saved, validated quote is public; never forward arbitrary profile fields.
			public.VideoPricing, _ = beefapi.NormalizeCatalogVideoPricing(item.VideoPricing)
		}
		index, exists := indexes[item.ChannelID]
		if !exists {
			index = len(channels)
			indexes[item.ChannelID] = index
			name := names[item.ChannelID]
			if name == "" {
				name = item.ChannelID
			}
			channels = append(channels, modelcatalog.PublicChannelCatalog{ID: item.ChannelID, Name: name, DisplayName: name, Models: []modelcatalog.PublicChannelModel{}})
		}
		channels[index].Models = append(channels[index].Models, public)
	}
	response := modelcatalog.NewCatalogResponse(modelcatalog.CatalogSourceSystem, nil, channels)
	return &response, nil
}
