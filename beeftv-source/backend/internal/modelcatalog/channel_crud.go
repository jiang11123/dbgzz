package modelcatalog

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

const maxAdminChannelModelImportCount = 500

func SelectCatalogModels(selected []string, catalog []string) ([]string, error) {
	if len(selected) == 0 {
		return nil, kernel.BadAuthRequest("请至少选择一个要导入的模型")
	}
	if len(selected) > maxAdminChannelModelImportCount {
		return nil, kernel.BadAuthRequest("单次最多导入 500 个模型")
	}
	available := make(map[string]string, len(catalog))
	for _, name := range catalog {
		available[channelModelCatalogKey(name)] = name
	}
	chosen := make([]string, 0, len(selected))
	seen := make(map[string]struct{}, len(selected))
	for _, rawName := range selected {
		name := strings.TrimPrefix(strings.TrimSpace(rawName), "models/")
		key := channelModelCatalogKey(name)
		if key == "" {
			continue
		}
		canonical, ok := available[key]
		if !ok {
			return nil, kernel.BadAuthRequest("所选模型不在上游模型目录中：" + name)
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		chosen = append(chosen, canonical)
	}
	if len(chosen) == 0 {
		return nil, kernel.BadAuthRequest("请至少选择一个有效的模型")
	}
	return chosen, nil
}

func MissingFetchedChannelModels(channelID string, names []string, existing []model.ChannelModel, retired map[string]bool, nextID IDGen) ([]model.ChannelModel, error) {
	return missingChannelModels(channelID, names, existing, retired, func(item model.ChannelModel) string {
		return channelModelCatalogKey(item.ModelKey)
	}, true, nextID)
}

func MissingImportedChannelModels(channelID string, names []string, existing []model.ChannelModel, retired map[string]bool, nextID IDGen) ([]model.ChannelModel, error) {
	return missingChannelModels(channelID, names, existing, retired, func(item model.ChannelModel) string {
		return channelModelCatalogKey(kernel.FirstNonEmpty(item.ProviderModelKey, item.ModelKey))
	}, false, nextID)
}

func missingChannelModels(channelID string, names []string, existing []model.ChannelModel, retired map[string]bool, existingKey func(model.ChannelModel) string, copyProviderKey bool, nextID IDGen) ([]model.ChannelModel, error) {
	if retired == nil {
		retired = map[string]bool{}
	}
	known := make(map[string]struct{}, len(existing))
	for _, item := range existing {
		if key := existingKey(item); key != "" {
			known[key] = struct{}{}
		}
	}
	missing := make([]model.ChannelModel, 0, len(names))
	for _, rawName := range names {
		name := strings.TrimPrefix(strings.TrimSpace(rawName), "models/")
		key := channelModelCatalogKey(name)
		if key == "" {
			continue
		}
		if _, ok := known[key]; ok || retired[key] {
			continue
		}
		modelID, idErr := nextID("MODEL")
		if idErr != nil {
			return nil, idErr
		}
		item := model.ChannelModel{ID: modelID, ChannelID: channelID, ModelKey: name, DisplayName: name, Enabled: false}
		if copyProviderKey {
			item.ProviderModelKey = name
		}
		missing = append(missing, item)
		known[key] = struct{}{}
	}
	return missing, nil
}

type ChannelModelSyncPlan struct {
	Create  []model.ChannelModel
	Disable []model.ChannelModel
}

func PlanInitialChannelModelSync(channel model.ModelChannel, names []string, existing []model.ChannelModel, nextID IDGen) (ChannelModelSyncPlan, error) {
	byKey := make(map[string]*model.ChannelModel, len(existing))
	for index := range existing {
		byKey[existing[index].ModelKey] = &existing[index]
	}
	desired := make(map[string]bool, len(names))
	retired := retiredChannelModelKeys(channel.RetiredModelsJSON)
	plan := ChannelModelSyncPlan{}
	for _, name := range kernel.UniqueNonEmpty(names) {
		name = strings.TrimPrefix(name, "models/")
		if name == "" || retired[channelModelCatalogKey(name)] {
			continue
		}
		desired[name] = true
		if byKey[name] != nil {
			continue
		}
		modelID, idErr := nextID("MODEL")
		if idErr != nil {
			return ChannelModelSyncPlan{}, idErr
		}
		plan.Create = append(plan.Create, model.ChannelModel{ID: modelID, ChannelID: channel.ID, ModelKey: name, DisplayName: name, Enabled: false})
	}
	for index := range existing {
		if desired[existing[index].ModelKey] || !existing[index].Enabled {
			continue
		}
		item := existing[index]
		item.Enabled = false
		plan.Disable = append(plan.Disable, item)
	}
	return plan, nil
}

func ValidateChannelModelDeleteSelection(ids []string, items []model.ChannelModel) error {
	selected := make(map[string]bool, len(ids))
	for _, id := range ids {
		selected[id] = true
	}
	found := 0
	for _, item := range items {
		if selected[item.ID] {
			found++
		}
	}
	if found != len(ids) {
		return kernel.BadAuthRequest("所选渠道模型中存在已删除或不属于当前渠道的记录，请刷新后重试")
	}
	return nil
}

func PrepareChannelModelSave(channelID, id string, req ChannelModelRequest, modelKey, providerModelKey, capability string, protocol model.ChannelInterfaceType, existing *model.ChannelModel, nextID IDGen) (*model.ChannelModel, []model.ChannelModelVariant, error) {
	if capability == "text" || capability == "image" || capability == "video" {
		if _, err := NormalizeModelCapabilityConfigForModel(capability, string(protocol), providerModelKey, req.CapabilityConfig); err != nil {
			return nil, nil, err
		}
	}
	tiers, err := NormalizeChannelModelVariants(req, capability, protocol, providerModelKey)
	if err != nil {
		return nil, nil, err
	}
	for index := range tiers {
		tierID, idErr := nextID("VARIANT")
		if idErr != nil {
			return nil, nil, idErr
		}
		tiers[index].ID = tierID
	}
	item := &model.ChannelModel{ID: "", ChannelID: channelID, Enabled: true}
	previousProviderModelKey := ""
	if strings.TrimSpace(id) != "" {
		if existing == nil {
			return nil, nil, kernel.BadAuthRequest("渠道模型不存在")
		}
		copied := *existing
		item = &copied
		previousProviderModelKey = strings.TrimPrefix(strings.TrimSpace(item.ProviderModelKey), "models/")
	} else {
		modelID, idErr := nextID("MODEL")
		if idErr != nil {
			return nil, nil, idErr
		}
		item.ID = modelID
	}
	tiers = CascadeUpstreamRename(tiers, previousProviderModelKey, providerModelKey)
	item.ModelKey = modelKey
	item.ProviderModelKey = providerModelKey
	item.DisplayName = strings.TrimSpace(req.DisplayName)
	if item.DisplayName == "" {
		item.DisplayName = modelKey
	}
	item.Icon = strings.TrimSpace(req.Icon)
	item.Capability = capability
	item.Protocol = protocol
	if capability == "text" || capability == "image" || capability == "video" {
		capabilityConfig, normalizeErr := NormalizeModelCapabilityConfigForModel(capability, string(protocol), providerModelKey, req.CapabilityConfig)
		if normalizeErr != nil {
			return nil, nil, normalizeErr
		}
		encoded, encodeErr := json.Marshal(capabilityConfig)
		if encodeErr != nil {
			return nil, nil, encodeErr
		}
		if item.CapabilityConfigJSON != string(encoded) {
			item.CapabilityVersion++
		}
		item.CapabilityConfigJSON = string(encoded)
	} else {
		item.CapabilityConfigJSON = ""
		item.CapabilityVersion = 0
	}
	if req.Enabled != nil {
		item.Enabled = *req.Enabled
	}
	if err := validateChannelModelTierCapabilities(tiers, item.CapabilityConfigJSON, capability); err != nil {
		return nil, nil, err
	}
	return item, tiers, nil
}

func HydrateChannelModelCapabilityConfig(items []model.ChannelModel) []model.ChannelModel {
	for index := range items {
		if strings.TrimSpace(items[index].CapabilityConfigJSON) == "" {
			continue
		}
		config, decodeErr := DecodeModelCapabilityConfig(items[index].CapabilityConfigJSON)
		if decodeErr != nil || config == nil {
			continue
		}
		normalized, normalizeErr := NormalizeModelCapabilityConfigForModel(items[index].Capability, string(items[index].Protocol), kernel.FirstNonEmpty(items[index].ProviderModelKey, items[index].ModelKey), config)
		if normalizeErr != nil || normalized == nil {
			continue
		}
		encoded, encodeErr := json.Marshal(normalized)
		var value map[string]any
		if encodeErr == nil && json.Unmarshal(encoded, &value) == nil {
			items[index].CapabilityConfig = value
		}
	}
	return items
}
