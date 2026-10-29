package modelcatalog

import (
	cryptorand "crypto/rand"
	"encoding/binary"
	"math"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/kernel"
)

func (r *Router) ResolveLogicalModel(logicalModelID string, intent ModelRequestIntent) (*RoutedModel, error) {
	snapshot, err := r.Snapshot()
	if err != nil {
		return nil, err
	}
	cached, ok := snapshot.Models[strings.TrimSpace(logicalModelID)]
	if !ok {
		return nil, kernel.BadAuthRequest("所选模型不可用")
	}
	intent.Options = mergeIntentDefaults(intent.Options, cached.Defaults)
	if match := MatchCapability(cached.ProductSpec, intent); !match.Matched {
		return nil, kernel.BadAuthRequest("所选模型不支持当前请求：" + strings.Join(match.Reasons, "；"))
	}
	eligible := r.EligibleLogicalRoutes(cached.Routes, intent, nil)
	if len(eligible) == 0 {
		return nil, kernel.BadAuthRequest("当前模型暂时无法满足这组输入和参数")
	}
	selected := WeightedRoute(eligible)
	variant := channelModelVariantForIntent(selected.ChannelModel, intent)
	return &RoutedModel{LogicalModel: cached.Model, Revision: cached.Revision, Route: selected.Route, ChannelModel: selected.ChannelModel, Variant: variant, Defaults: cached.Defaults}, nil
}

func (r *Router) EligibleLogicalRoutes(routes []CachedLogicalRoute, intent ModelRequestIntent, tried map[string]bool) []CachedLogicalRoute {
	eligible := make([]CachedLogicalRoute, 0, len(routes))
	maxPriority := math.MinInt
	for _, route := range routes {
		if !route.Route.Enabled || route.Route.Weight <= 0 || tried[route.Route.ID] || r.LogicalRouteBlocked(route) {
			continue
		}
		if match := MatchCapability(route.CapabilitySpec, intent); !match.Matched {
			continue
		}
		if len(route.ChannelModel.Variants) > 0 && channelModelVariantForIntent(route.ChannelModel, intent) == nil {
			continue
		}
		if route.Route.Priority > maxPriority {
			eligible = eligible[:0]
			maxPriority = route.Route.Priority
		}
		if route.Route.Priority == maxPriority {
			eligible = append(eligible, route)
		}
	}
	return eligible
}

func WeightedRoute(routes []CachedLogicalRoute) CachedLogicalRoute {
	if len(routes) == 1 {
		return routes[0]
	}
	var total int64
	for _, route := range routes {
		total += int64(route.Route.Weight)
	}
	if total <= 0 {
		return routes[0]
	}
	var raw [8]byte
	if _, err := cryptorand.Read(raw[:]); err != nil {
		return routes[0]
	}
	totalUnsigned := uint64(total)
	threshold := -totalUnsigned % totalUnsigned
	randomValue := binary.LittleEndian.Uint64(raw[:])
	for randomValue < threshold {
		if _, err := cryptorand.Read(raw[:]); err != nil {
			return routes[0]
		}
		randomValue = binary.LittleEndian.Uint64(raw[:])
	}
	pick := int64(randomValue % totalUnsigned)
	for _, route := range routes {
		if pick < int64(route.Route.Weight) {
			return route
		}
		pick -= int64(route.Route.Weight)
	}
	return routes[len(routes)-1]
}

func (r *Router) SortedRouteDiagnostics(routes []CachedLogicalRoute, intent ModelRequestIntent) []RouteSimulationCandidate {
	result := make([]RouteSimulationCandidate, 0, len(routes))
	poolPriority := math.MinInt
	for _, route := range routes {
		match := MatchCapability(route.CapabilitySpec, intent)
		blocked := r.LogicalRouteBlocked(route)
		if route.Route.Enabled && route.Route.Weight > 0 && match.Matched && !blocked && route.Route.Priority > poolPriority {
			poolPriority = route.Route.Priority
		}
		result = append(result, RouteSimulationCandidate{RouteID: route.Route.ID, ChannelModelID: route.ChannelModel.ID, ChannelModelKey: route.ChannelModel.ModelKey, ChannelModelName: route.ChannelModel.DisplayName, Priority: route.Route.Priority, Weight: route.Route.Weight, Enabled: route.Route.Enabled, Matched: match.Matched, Blocked: blocked, Reasons: match.Reasons})
	}
	for index := range result {
		result[index].InPool = result[index].Enabled && result[index].Weight > 0 && result[index].Matched && !result[index].Blocked && result[index].Priority == poolPriority
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].Priority > result[j].Priority })
	return result
}

func (r *Router) SimulateLogicalModelRoute(id string, intent ModelRequestIntent) (*RouteSimulationResult, error) {
	snapshot, err := r.Snapshot()
	if err != nil {
		return nil, err
	}
	cached, ok := snapshot.Models[id]
	if !ok {
		return nil, kernel.BadAuthRequest("前台模型未启用或尚未发布")
	}
	intent.Options = mergeIntentDefaults(intent.Options, cached.Defaults)
	return &RouteSimulationResult{ProductMatch: MatchCapability(cached.ProductSpec, intent), Candidates: r.SortedRouteDiagnostics(cached.Routes, intent)}, nil
}

func (r *Router) PublicLogicalModels(intent *ModelRequestIntent) ([]PublicLogicalModel, error) {
	snapshot, err := r.Snapshot()
	if err != nil {
		return nil, err
	}
	result := make([]PublicLogicalModel, 0, len(snapshot.Ordered))
	for _, id := range snapshot.Ordered {
		cached := snapshot.Models[id]
		structuralSpecs := AvailableCachedRouteSpecs(cached.Routes)
		coverageValid := LogicalModelCapabilityCovered(cached.ProductSpec, structuralSpecs)
		available := coverageValid && r.HasHealthyCachedRoute(cached.Routes)
		if intent != nil {
			resolvedIntent := *intent
			resolvedIntent.Options = mergeIntentDefaults(intent.Options, cached.Defaults)
			productMatch := MatchCapability(cached.ProductSpec, resolvedIntent)
			if !productMatch.Matched {
				continue
			}
			available = false
			if coverageValid {
				for _, route := range cached.Routes {
					if route.Route.Enabled && route.Route.Weight > 0 && !r.LogicalRouteBlocked(route) && MatchCapability(route.CapabilitySpec, resolvedIntent).Matched {
						available = true
						break
					}
				}
			}
		}
		result = append(result, ProjectPublicLogicalModel(cached, available))
	}
	return result, nil
}

func ProjectPublicLogicalModel(cached CachedLogicalModel, available bool) PublicLogicalModel {
	item := cached.Model
	productSpec := capabilitySpecWithRoutePresets(cached.ProductSpec, EnabledLogicalRouteSpecs(cached.Routes))
	profiles := make([]CapabilitySpec, 0, len(cached.Routes))
	seen := make(map[string]bool, len(cached.Routes))
	for _, route := range cached.Routes {
		if !route.Route.Enabled || route.Route.Weight <= 0 {
			continue
		}
		key := capabilityFingerprint(route.CapabilitySpec)
		if !seen[key] {
			seen[key] = true
			profiles = append(profiles, route.CapabilitySpec)
		}
	}
	return PublicLogicalModel{
		ID: item.ID, Code: item.Code, Name: item.Name, Icon: item.Icon,
		Description: item.Description, Capability: item.Capability, SortOrder: item.SortOrder,
		LegacyModelIDs: decodeLegacyModelIDs(item.LegacyModelIDsJSON),
		CapabilitySpec: productSpec, CapabilityProfiles: profiles,
		DefaultOptions: cached.Defaults, Available: available,
	}
}

func EnabledLogicalRouteSpecs(routes []CachedLogicalRoute) []CapabilitySpec {
	specs := make([]CapabilitySpec, 0, len(routes))
	for _, route := range routes {
		if !route.Route.Enabled || route.Route.Weight <= 0 {
			continue
		}
		specs = append(specs, route.CapabilitySpec)
	}
	return specs
}

func AvailableCachedRouteSpecs(routes []CachedLogicalRoute) []CapabilitySpec {
	result := make([]CapabilitySpec, 0, len(routes))
	for _, route := range routes {
		if route.Route.Enabled && route.Route.Weight > 0 {
			result = append(result, route.CapabilitySpec)
		}
	}
	return result
}

func (r *Router) HasHealthyCachedRoute(routes []CachedLogicalRoute) bool {
	for _, route := range routes {
		if route.Route.Enabled && route.Route.Weight > 0 && !r.LogicalRouteBlocked(route) {
			return true
		}
	}
	return false
}

func LogicalModelCapabilityCovered(product CapabilitySpec, routeSpecs []CapabilitySpec) bool {
	return len(routeSpecs) > 0 && validateProductSpecWithinRoutes(product, routeSpecs) == nil
}

func LogicalModelConfigurationError(product CapabilitySpec, routeSpecs []CapabilitySpec) string {
	if len(routeSpecs) == 0 || LogicalModelCapabilityCovered(product, routeSpecs) {
		return ""
	}
	return "供应线路已无法完整覆盖创作端能力，请调整线路或能力范围"
}

func ApplyRoutedProviderSelection(input map[string]any, routed *RoutedModel) map[string]any {
	if routed == nil {
		return input
	}
	config, _ := input["config"].(map[string]any)
	nextConfig := make(map[string]any, len(config)+2)
	for key, value := range config {
		switch key {
		case "channelId", "channelModelKey", "variantId", "providerModelKey", "apiFormat", "interfaceType", "baseUrl", "apiKey", "secretKey", "headers", "model", "capabilityConfig":
			continue
		default:
			nextConfig[key] = value
		}
	}
	for key, value := range routed.Defaults {
		canonical := canonicalCapabilityOptionName(key)
		if existing, exists := nextConfig[canonical]; !exists || existing == nil || strings.TrimSpace(fmtSprint(existing)) == "" {
			nextConfig[canonical] = providerConfigOptionValue(value)
		}
	}
	if options, ok := input["capabilityOptions"].(map[string]any); ok {
		for key, value := range options {
			canonical := canonicalCapabilityOptionName(key)
			if isProviderCapabilityOption(canonical) {
				nextConfig[canonical] = providerConfigOptionValue(value)
			}
		}
	}
	nextConfig["channelId"] = routed.ChannelModel.ChannelID
	nextConfig["model"] = routed.ChannelModel.ModelKey
	nextConfig["channelModelKey"] = routed.ChannelModel.ModelKey
	if routed.Variant != nil {
		nextConfig["variantId"] = routed.Variant.ID
		nextConfig["providerModelKey"] = routed.Variant.ProviderModelKey
	}
	input["config"] = nextConfig
	return input
}

func providerConfigOptionValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case jsonNumber:
		return typed.String()
	default:
		return fmtSprint(value)
	}
}
