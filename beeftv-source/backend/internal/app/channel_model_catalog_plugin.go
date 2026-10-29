package app

import (
	"net/url"
	"os"
	"strings"
	"sync"

	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/provider"
	"infinite-canvas/backend/internal/provider/bailian"
)

var pluginsInitOnce sync.Once

func initModelCatalogPlugins() {
	pluginsInitOnce.Do(func() {
		provider.Register(bailian.New())
	})
}

// extraChannelModelCatalogItems returns vendor catalog entries after the
// unified outbound /models fetch. Plugins do not hold secrets or issue HTTP.
func extraChannelModelCatalogItems(baseURL, apiFormat string, headers []modelcatalog.ChannelHeader) []modelcatalog.ChannelModelCatalogItem {
	initModelCatalogPlugins()
	discovery := provider.MatchProvider(baseURL, outboundHeadersMap(headers))
	if discovery == nil {
		return nil
	}
	extra := discovery.AdditionalModels(provider.DiscoveryConfig{
		BaseURL:   baseURL,
		APIFormat: apiFormat,
		Headers:   outboundHeadersMap(headers),
		Region:    modelCatalogRegion(baseURL),
	})
	if len(extra) == 0 {
		return nil
	}
	items := make([]modelcatalog.ChannelModelCatalogItem, 0, len(extra))
	for _, model := range extra {
		item := providerCatalogItem(model)
		if item.ID == "" {
			continue
		}
		items = append(items, item)
	}
	return items
}

func providerCatalogItem(item provider.Model) modelcatalog.ChannelModelCatalogItem {
	modelType := ""
	for _, capability := range item.Capability {
		if normalized := modelcatalog.NormalizeCatalogModelType(capability); normalized != "" {
			modelType = normalized
			break
		}
	}
	return modelcatalog.ChannelModelCatalogItem{
		ID:                     strings.TrimPrefix(strings.TrimSpace(item.ID), "models/"),
		DisplayName:            strings.TrimSpace(item.DisplayName),
		ModelType:              modelType,
		SupportedEndpointTypes: modelcatalog.NormalizeCatalogEndpointTypes(item.SupportedEndpointTypes),
	}
}

func outboundHeadersMap(headers []OutboundHeader) map[string]string {
	result := make(map[string]string, len(headers))
	for _, header := range headers {
		result[header.Name] = header.Value
	}
	return result
}

func modelCatalogRegion(baseURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if strings.Contains(host, "dashscope-us") {
		return "us-east-1"
	}
	if strings.Contains(host, "ap-southeast-1") {
		return "ap-southeast-1"
	}
	return "cn-beijing"
}

func (s *Service) isPluginEnabled() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv("ENABLE_PROVIDER_PLUGINS")))
	return value == "true" || value == "1"
}
