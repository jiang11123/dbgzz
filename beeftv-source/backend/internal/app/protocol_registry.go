package app

import (
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func (s *Service) protocolRegistry() *protocol.Registry {
	if registry := s.pluginDomain().Registry(); registry != nil {
		return registry
	}
	return loadOfficialFallbackRegistry()
}

func (s *Service) protocolMetadata(id string) (protocol.Metadata, bool) {
	adapter, ok := s.protocolRegistry().Resolve(strings.TrimSpace(id))
	if !ok {
		return protocol.Metadata{}, false
	}
	return adapter.Metadata(), true
}

func (s *Service) channelProtocolMetadata(id string) (protocol.Metadata, bool) {
	return s.protocolMetadata(id)
}

func (s *Service) canonicalProtocolID(id string) (string, bool) {
	adapter, ok := s.protocolRegistry().Resolve(strings.TrimSpace(id))
	if !ok {
		return "", false
	}
	return adapter.Metadata().ID, true
}

func (s *Service) protocolIsSelectable(id string) bool {
	metadata, ok := s.channelProtocolMetadata(id)
	return ok && metadata.Enabled && metadata.UnavailableReason == ""
}

func (s *Service) InstallPlugin(data []byte, fileName string) (PluginView, error) {
	return s.pluginDomain().Install(data, fileName)
}

func (s *Service) InstallPluginForAdmin(actor *model.User, data []byte, fileName string) (PluginView, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return PluginView{}, err
	}
	plugin, err := s.pluginDomain().InstallUploaded(actor.ID, data, fileName)
	if err != nil {
		return PluginView{}, mapPluginAccessError(err)
	}
	if err := s.appendAdminAudit(actor, "plugin.install", "plugin", plugin.Manifest.ID, "安装自定义插件", map[string]any{"fileName": fileName, "sha256": plugin.SHA256}); err != nil {
		return PluginView{}, err
	}
	return plugin, nil
}

func (s *Service) PluginPackage(id string) ([]byte, string, error) {
	return s.pluginDomain().Package(id)
}

func (s *Service) SetPluginEnabled(id string, enabled bool) (PluginView, error) {
	return s.pluginDomain().SetEnabled(id, enabled)
}

func (s *Service) UninstallPlugin(id string) error {
	return s.pluginDomain().Uninstall(id)
}

func (s *Service) UninstallPluginForAdmin(actor *model.User, id string) error {
	if err := s.RequireAdmin(actor); err != nil {
		return err
	}
	if err := s.pluginDomain().UninstallUploaded(id); err != nil {
		return mapPluginAccessError(err)
	}
	return s.appendAdminAudit(actor, "plugin.uninstall", "plugin", id, "卸载自定义插件", nil)
}
