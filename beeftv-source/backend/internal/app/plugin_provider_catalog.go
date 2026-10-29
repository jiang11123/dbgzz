package app

import "infinite-canvas/backend/internal/plugins"

type PluginProviderCatalogItem = plugins.ProviderCatalogItem

func (s *Service) PluginProviderCatalog(scope, capability string, includeUnavailable bool) []PluginProviderCatalogItem {
	return s.pluginDomain().ProviderCatalog(scope, capability, includeUnavailable)
}
