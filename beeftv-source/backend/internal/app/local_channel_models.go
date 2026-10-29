package app

import (
	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/modelcatalog"
)

type localChannelModel = modelcatalog.LocalChannelModel

func (s *Service) localChannelModels() []localChannelModel {
	if s == nil || !s.IsLocalMode() {
		return nil
	}
	body, err := s.ReadLocalModelConfig()
	if err != nil || len(body) == 0 {
		return nil
	}
	return modelcatalog.ParseLocalChannelModels(body)
}

func (s *Service) localChannelModel(channelID, modelKey string) (localChannelModel, bool) {
	for _, item := range s.localChannelModels() {
		if item.ChannelID == channelID && item.Model == modelKey {
			return item, true
		}
	}
	return localChannelModel{}, false
}

func (s *Service) localChannelModelListItems(intent *ModelRequestIntent) []map[string]any {
	items := []map[string]any{}
	for _, item := range modelcatalog.FilterLocalChannelModels(s.localChannelModels(), intent) {
		selection := map[string]any{"channelId": item.ChannelID, "channelModelKey": item.Model}
		if item.ChannelID == beefapi.ChannelID {
			selection["credentialRef"] = managedBeefAPIRef
		}
		entry := map[string]any{"name": item.DisplayName, "capability": item.Capability, "selection": selection}
		if item.CapabilityConfig != nil {
			entry["options"] = item.CapabilityConfig
		}
		items = append(items, entry)
	}
	return items
}

func catalogModelName(raw any) string {
	item, _ := raw.(map[string]any)
	if item == nil {
		return ""
	}
	if name, _ := item["name"].(string); name != "" {
		return name
	}
	return ""
}

func coerceCatalogModels(value any) []map[string]any {
	switch typed := value.(type) {
	case []map[string]any:
		return append([]map[string]any{}, typed...)
	case []any:
		items := make([]map[string]any, 0, len(typed))
		for _, raw := range typed {
			item, _ := raw.(map[string]any)
			if item == nil {
				continue
			}
			items = append(items, item)
		}
		return items
	default:
		return []map[string]any{}
	}
}
