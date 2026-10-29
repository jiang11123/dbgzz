package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/plugins"
)

const (
	PluginEagleAssetConnector = plugins.EagleAssetConnector
	PluginPromptOptimizer     = plugins.PromptOptimizer
	PluginPortraitClearance   = plugins.PortraitClearance
	PluginAIArtCritique       = plugins.AIArtCritique
	PluginMediaConversion     = plugins.MediaConversion
	PluginEditorShell         = plugins.EditorShell

	PluginOriginOfficial = plugins.OriginOfficial
	PluginOriginSystem   = plugins.OriginSystem
	PluginOriginUploaded = plugins.OriginUploaded

	PluginKindProtocol    = plugins.KindProtocol
	PluginKindApplication = plugins.KindApplication

	PluginScopeSystem = plugins.ScopeSystem
	PluginScopeUser   = plugins.ScopeUser

	PluginConfigurationNone   = plugins.ConfigurationNone
	PluginConfigurationSystem = plugins.ConfigurationSystem
	PluginConfigurationUser   = plugins.ConfigurationUser
)

type PluginManagementView = plugins.ManagementView
type PluginStateView = plugins.StateView
type AdminPluginStateView = plugins.AdminStateView

func pluginManagement(pluginID string, source string) PluginManagementView {
	return plugins.Management(pluginID, source)
}

func (s *Service) Plugins() []PluginView {
	return s.pluginDomain().List()
}

func (s *Service) PluginsForUser(actor *model.User) ([]PluginView, error) {
	visible := true
	if actor == nil || actor.Role != model.UserRoleAdmin {
		var err error
		visible, err = s.FeatureEnabled(FeatureSystemPlugins)
		if err != nil {
			return nil, err
		}
	}
	return s.pluginDomain().ForUser(actor, visible), nil
}

func (s *Service) PluginStatesForUser(actor *model.User) (map[string]PluginStateView, error) {
	return s.pluginDomain().StatesForUser(actor)
}

func (s *Service) SetUserPluginEnabled(actor *model.User, pluginID string, enabled bool) (PluginStateView, error) {
	state, err := s.pluginDomain().SetUserEnabled(actor, pluginID, enabled)
	return state, mapPluginAccessError(err)
}

func (s *Service) AdminPluginStates(actor *model.User) (map[string]AdminPluginStateView, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	return s.pluginDomain().AdminStates(actor)
}

func (s *Service) SetPluginPlatformAvailability(actor *model.User, pluginID string, available bool) (AdminPluginStateView, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return AdminPluginStateView{}, err
	}
	_, policy, err := s.pluginDomain().SetPlatformAvailability(actor, pluginID, available)
	if err != nil {
		return AdminPluginStateView{}, mapPluginAccessError(err)
	}
	if err := s.appendAdminAudit(actor, "plugin.availability.update", "plugin", pluginID, "更新插件平台可用状态", map[string]any{"available": available, "kind": policy.Kind, "origin": policy.Origin}); err != nil {
		return AdminPluginStateView{}, err
	}
	states, err := s.AdminPluginStates(actor)
	if err != nil {
		return AdminPluginStateView{}, err
	}
	return states[pluginID], nil
}

func (s *Service) RequirePluginForUser(userID string, pluginID string) error {
	return mapPluginAccessError(s.pluginDomain().RequireForUser(userID, pluginID))
}
