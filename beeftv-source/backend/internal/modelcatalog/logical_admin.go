package modelcatalog

import (
	"errors"

	"infinite-canvas/backend/internal/model"
)

func BuildAdminLogicalModel(item model.LogicalModel, graph LogicalModelGraph, systemChannelByID map[string]model.ModelChannel) (*AdminLogicalModel, error) {
	if graph.Revision == nil {
		return nil, errors.New("前台模型版本不存在")
	}
	productSpec, err := DecodeCapabilitySpec(graph.Revision.CapabilitySpecJSON)
	if err != nil {
		return nil, err
	}
	channelModelByID := make(map[string]model.ChannelModel, len(graph.ChannelModels))
	for _, channelModel := range graph.ChannelModels {
		channelModelByID[channelModel.ID] = channelModel
	}
	admin := AdminLogicalModel{PublicLogicalModel: ProjectPublicLogicalModel(CachedLogicalModel{Model: item, ProductSpec: productSpec, Defaults: map[string]any{}}, false), Enabled: item.Enabled, ActiveRevisionID: graph.Revision.ID, RevisionVersion: graph.Revision.Version, Routes: []AdminLogicalRoute{}}
	for _, route := range graph.Routes {
		channelModel, channelOK := channelModelByID[route.ChannelModelID]
		if !channelOK {
			return nil, errors.New("供应线路引用的渠道模型不存在")
		}
		capabilitySpec, specErr := channelModelCapabilitySpec(channelModel)
		if specErr != nil {
			return nil, specErr
		}
		_, channelOK = systemChannelByID[channelModel.ChannelID]
		structurallyAvailable := route.Enabled && route.Weight > 0 && channelModel.Enabled && channelOK
		admin.Routes = append(admin.Routes, AdminLogicalRoute{ID: route.ID, ChannelModelID: channelModel.ID, ChannelID: channelModel.ChannelID, ChannelModelKey: channelModel.ModelKey, ChannelModelName: channelModel.DisplayName, Enabled: route.Enabled, Priority: route.Priority, Weight: route.Weight, Available: structurallyAvailable, StructurallyAvailable: structurallyAvailable, CapabilitySpec: capabilitySpec})
	}
	routeSpecs := make([]CapabilitySpec, 0, len(admin.Routes))
	for _, route := range admin.Routes {
		routeSpecs = append(routeSpecs, route.CapabilitySpec)
	}
	productSpec = capabilitySpecWithRoutePresets(productSpec, routeSpecs)
	defaults, err := DecodeLogicalDefaults(graph.Revision.DefaultOptionsJSON, productSpec)
	if err != nil {
		return nil, err
	}
	admin.PublicLogicalModel = ProjectPublicLogicalModel(CachedLogicalModel{Model: item, ProductSpec: productSpec, Defaults: defaults}, false)
	admin.CapabilitySpec = productSpec
	admin.DefaultOptions = defaults
	structuralRouteSpecs := StructuralAdminRouteSpecs(admin.Routes)
	admin.ConfigurationError = LogicalModelConfigurationError(productSpec, structuralRouteSpecs)
	admin.AvailabilityError = ""
	admin.Available = len(structuralRouteSpecs) > 0 && admin.ConfigurationError == ""
	return &admin, nil
}

func StructuralAdminRouteSpecs(routes []AdminLogicalRoute) []CapabilitySpec {
	result := make([]CapabilitySpec, 0, len(routes))
	for _, route := range routes {
		if route.StructurallyAvailable {
			result = append(result, route.CapabilitySpec)
		}
	}
	return result
}

func ArchiveLogicalModelGuard(item *model.LogicalModel) error {
	if item == nil || item.ArchivedAt != nil {
		return kernelBad("前台模型不存在或已删除")
	}
	if item.SourceChannelModelID != "" {
		return kernelBad("该前台模型由系统渠道自动同步，请在系统渠道模型中停用")
	}
	return nil
}

func kernelBad(message string) error {
	return badAuth(message)
}
