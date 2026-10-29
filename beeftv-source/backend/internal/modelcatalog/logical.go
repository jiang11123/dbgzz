package modelcatalog

import (
	"encoding/json"
	"math"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func decodeLegacyModelIDs(raw string) []string {
	var values []string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return []string{}
	}
	return normalizeLegacyModelIDs(values)
}

func normalizeLegacyModelIDs(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func capabilitySpecWithRoutePresets(spec CapabilitySpec, routes []CapabilitySpec) CapabilitySpec {
	result := spec
	result.Options = make(map[string]OptionConstraint, len(spec.Options))
	for name, constraint := range spec.Options {
		if !isWildcardOptionConstraint(constraint) {
			result.Options[name] = constraint
			continue
		}
		values := append([]any(nil), constraint.Values...)
		seen := make(map[string]bool, len(values))
		for _, value := range values {
			seen[normalizedScalar(value)] = true
		}
		for _, route := range routes {
			for _, value := range route.Options[name].Values {
				key := normalizedScalar(value)
				if key != "" && !seen[key] {
					seen[key] = true
					values = append(values, value)
				}
			}
		}
		result.Options[name] = OptionConstraint{Values: values}
	}
	// 前台规格里的预设可能只来自单条线路的快照（后续新增的供应线路还没同步进来），
	// 因此不管自身是否已有预设都要与各线路取并集，否则多档会被压成单档。
	if merged := mergeCapabilityImageSize(append([]CapabilitySpec{spec}, routes...)); merged != nil {
		if result.ImageSize == nil {
			result.ImageSize = merged
		} else {
			restored := *result.ImageSize
			if restored.Parameter == "" {
				restored.Parameter = merged.Parameter
			}
			if !restored.AllowCustom {
				restored.AllowCustom = merged.AllowCustom
			}
			restored.Presets = merged.Presets
			result.ImageSize = &restored
		}
	}
	return result
}

func mergeCapabilityImageSize(specs []CapabilitySpec) *CapabilityImageSize {
	var result *CapabilityImageSize
	seen := map[string]bool{}
	for _, spec := range specs {
		part := spec.ImageSize
		if part == nil {
			continue
		}
		if result == nil {
			result = &CapabilityImageSize{Parameter: part.Parameter, AllowCustom: part.AllowCustom}
		} else {
			if result.Parameter != "aspect_ratio" && part.Parameter == "aspect_ratio" {
				result.Parameter = "aspect_ratio"
			} else if result.Parameter == "" {
				result.Parameter = part.Parameter
			}
			result.AllowCustom = result.AllowCustom || part.AllowCustom
		}
		for _, preset := range part.Presets {
			key := preset.Tier + ":" + preset.Ratio + ":" + preset.Size
			if key == "::" || seen[key] {
				continue
			}
			seen[key] = true
			result.Presets = append(result.Presets, preset)
		}
	}
	return result
}

func capabilityFingerprint(spec CapabilitySpec) string {
	copySpec := spec
	copySpec.Operations = append([]string(nil), spec.Operations...)
	sort.Strings(copySpec.Operations)
	copySpec.Inputs = make(map[string]InputConstraint, len(spec.Inputs))
	for name, constraint := range spec.Inputs {
		copySpec.Inputs[name] = constraint
	}
	copySpec.Options = make(map[string]OptionConstraint, len(spec.Options))
	for name, constraint := range spec.Options {
		values := append([]any(nil), constraint.Values...)
		sort.SliceStable(values, func(i, j int) bool { return normalizedScalar(values[i]) < normalizedScalar(values[j]) })
		constraint.Values = values
		copySpec.Options[name] = constraint
	}
	encoded, _ := json.Marshal(copySpec)
	return string(encoded)
}

func normalizeLogicalDefaults(spec CapabilitySpec, defaults map[string]any) (map[string]any, error) {
	result := make(map[string]any, len(defaults))
	for rawName, value := range defaults {
		name := canonicalCapabilityOptionName(rawName)
		if _, exists := result[name]; exists {
			return nil, kernel.BadAuthRequest("默认参数存在重复别名：" + name)
		}
		constraint, ok := spec.Options[name]
		if !ok || !matchOptionConstraint(name, constraint, value) {
			return nil, kernel.BadAuthRequest("默认参数 " + name + " 不在前台模型能力范围内")
		}
		// `*` 只表示允许任意自定义值，不能作为创作端默认参数发送。
		if normalizedScalar(value) == "*" {
			for _, candidate := range constraint.Values {
				if normalizedScalar(candidate) != "*" {
					value = candidate
					break
				}
			}
		}
		result[name] = value
	}
	return result, nil
}

func channelModelCapabilitySpec(channelModel model.ChannelModel) (CapabilitySpec, error) {
	config, err := DecodeModelCapabilityConfig(channelModel.CapabilityConfigJSON)
	if err != nil {
		return CapabilitySpec{}, kernel.BadAuthRequest("渠道模型能力配置无效，请先修复渠道模型")
	}
	if config != nil {
		config, err = NormalizeModelCapabilityConfigForModel(normalizeCapability(channelModel.Capability), string(channelModel.Protocol), kernel.FirstNonEmpty(channelModel.ProviderModelKey, channelModel.ModelKey), config)
		if err != nil {
			return CapabilitySpec{}, err
		}
	}
	spec, err := CapabilitySpecFromModelCapabilityConfig(config, normalizeCapability(channelModel.Capability))
	if err != nil {
		return CapabilitySpec{}, err
	}
	return capabilitySpecWithVariants(spec, channelModel), nil
}

func capabilitySpecWithVariants(spec CapabilitySpec, channelModel model.ChannelModel) CapabilitySpec {
	if normalizeCapability(spec.Capability) != "video" || len(channelModel.Variants) == 0 {
		return spec
	}
	tiers := make([]model.ChannelModelVariant, 0, len(channelModel.Variants))
	for _, tier := range channelModel.Variants {
		if tier.Enabled {
			tiers = append(tiers, tier)
		}
	}
	if len(tiers) == 0 {
		return spec
	}
	result := spec
	result.Options = make(map[string]OptionConstraint, len(spec.Options))
	for name, option := range spec.Options {
		result.Options[name] = option
	}
	hasResolutionWildcard, hasDurationWildcard := false, false
	resolutions := make([]any, 0, len(tiers))
	durations := make([]any, 0, len(tiers))
	seenResolutions := make(map[string]bool, len(tiers))
	seenDurations := make(map[int]bool, len(tiers))
	for _, tier := range tiers {
		if normalizeChannelModelTierResolution(tier.Resolution) == "*" {
			hasResolutionWildcard = true
		} else if value := normalizeChannelModelTierResolution(tier.Resolution); !seenResolutions[value] {
			seenResolutions[value] = true
			resolutions = append(resolutions, value)
		}
		if tier.VideoSeconds == 0 {
			hasDurationWildcard = true
		} else if !seenDurations[tier.VideoSeconds] {
			seenDurations[tier.VideoSeconds] = true
			durations = append(durations, tier.VideoSeconds)
		}
	}
	if !hasResolutionWildcard && len(resolutions) > 0 {
		result.Options["vquality"] = OptionConstraint{Values: resolutions}
	}
	if !hasDurationWildcard && len(durations) > 0 {
		result.Options["videoSeconds"] = OptionConstraint{Values: durations}
	}
	return result
}

func channelModelDefaultOptions(channelModel model.ChannelModel, spec CapabilitySpec) (map[string]any, error) {
	config, err := DecodeModelCapabilityConfig(channelModel.CapabilityConfigJSON)
	if err != nil {
		return nil, kernel.BadAuthRequest("渠道模型能力配置无效，请先修复渠道模型")
	}
	if config != nil {
		config, err = NormalizeModelCapabilityConfigForModel(normalizeCapability(channelModel.Capability), string(channelModel.Protocol), kernel.FirstNonEmpty(channelModel.ProviderModelKey, channelModel.ModelKey), config)
		if err != nil {
			return nil, err
		}
	}
	defaults := make(map[string]any)
	if config != nil {
		switch normalizeCapability(channelModel.Capability) {
		case "image":
			if config.Image != nil {
				defaults["size"] = config.Image.Size.Default
				if config.Image.Quality.Supported {
					defaults["quality"] = config.Image.Quality.Default
				}
				if config.Image.TransparentBackground.Supported {
					defaults["transparentBackground"] = config.Image.TransparentBackground.Default
				}
			}
		case "video":
			if config.Video != nil {
				defaults["videoSeconds"] = config.Video.Duration.Default
				defaults["vquality"] = normalizeChannelModelTierResolution(config.Video.DefaultResolution)
				defaults["size"] = config.Video.DefaultRatio
				if config.Video.GenerateAudio.Supported {
					defaults["videoGenerateAudio"] = config.Video.GenerateAudio.Default
				}
				if config.Video.Watermark.Supported {
					defaults["videoWatermark"] = config.Video.Watermark.Default
				}
			}
		}
	}
	// 当渠道默认规格没有变体时，优先选择第一个可用变体。
	if normalizeCapability(channelModel.Capability) == "video" && channelModelVariantForIntent(channelModel, ModelRequestIntent{Capability: "video", Options: defaults}) == nil {
		for _, tier := range channelModel.Variants {
			if !tier.Enabled {
				continue
			}
			if tier.Resolution != "*" {
				defaults["vquality"] = normalizeChannelModelTierResolution(tier.Resolution)
			}
			if tier.VideoSeconds > 0 {
				defaults["videoSeconds"] = tier.VideoSeconds
			}
			break
		}
	}
	return normalizeLogicalDefaults(spec, defaults)
}

func validateProductSpecWithinRoutes(product CapabilitySpec, routeSpecs []CapabilitySpec) error {
	for _, routeSpec := range routeSpecs {
		if normalizeCapability(routeSpec.Capability) != normalizeCapability(product.Capability) {
			return kernel.BadAuthRequest("供应线路能力类型与前台模型不一致")
		}
	}
	if len(product.Operations) == 0 {
		unrestricted := false
		for _, routeSpec := range routeSpecs {
			if len(routeSpec.Operations) == 0 {
				unrestricted = true
				break
			}
		}
		if !unrestricted {
			return kernel.BadAuthRequest("创作端生成方式必须从供应线路支持的选项中选择")
		}
	} else {
		for _, operation := range product.Operations {
			supported := false
			for _, routeSpec := range routeSpecs {
				if len(routeSpec.Operations) == 0 || containsCapabilityString(routeSpec.Operations, operation) {
					supported = true
					break
				}
			}
			if !supported {
				return kernel.BadAuthRequest("创作端生成方式不受任何供应线路支持：" + operation)
			}
		}
	}
	for name, constraint := range product.Inputs {
		if !inputConstraintCovered(constraint, name, routeSpecs) {
			return kernel.BadAuthRequest("创作端输入范围超出供应线路能力：" + name)
		}
	}
	for name, constraint := range product.Options {
		if !optionConstraintCovered(constraint, name, routeSpecs) {
			return kernel.BadAuthRequest("创作端参数超出供应线路能力：" + name)
		}
	}
	return nil
}

func inputConstraintCovered(candidate InputConstraint, name string, routeSpecs []CapabilitySpec) bool {
	next := candidate.Min
	for next <= candidate.Max {
		coveredUntil := next - 1
		for _, routeSpec := range routeSpecs {
			constraint, exists := routeSpec.Inputs[name]
			if !exists {
				constraint = InputConstraint{Min: 0, Max: 0}
			}
			if constraint.Min <= next && constraint.Max >= next && constraint.Max > coveredUntil {
				coveredUntil = constraint.Max
			}
		}
		if coveredUntil < next {
			return false
		}
		next = coveredUntil + 1
	}
	return true
}

func optionConstraintCovered(candidate OptionConstraint, name string, routeSpecs []CapabilitySpec) bool {
	routeConstraints := make([]OptionConstraint, 0, len(routeSpecs))
	for _, routeSpec := range routeSpecs {
		if constraint, exists := routeSpec.Options[name]; exists {
			routeConstraints = append(routeConstraints, constraint)
		}
	}
	if len(routeConstraints) == 0 {
		return false
	}
	for _, routeConstraint := range routeConstraints {
		if isWildcardOptionConstraint(routeConstraint) {
			return true
		}
	}
	if len(candidate.Values) > 0 {
		for _, value := range candidate.Values {
			if !optionValueSupported(name, value, routeConstraints) {
				return false
			}
		}
		return true
	}
	if candidate.Min == nil || candidate.Max == nil {
		return false
	}
	if math.Abs(*candidate.Max-*candidate.Min) < 1e-9 {
		return optionValueSupported(name, *candidate.Min, routeConstraints)
	}
	if candidate.Step == nil {
		return continuousOptionRangeCovered(*candidate.Min, *candidate.Max, routeConstraints)
	}
	step := *candidate.Step
	count := int(math.Floor((*candidate.Max-*candidate.Min)/step+1e-9)) + 1
	if count <= 10000 {
		for index := 0; index < count; index++ {
			value := *candidate.Min + float64(index)*step
			if !optionValueSupported(name, value, routeConstraints) {
				return false
			}
		}
		return true
	}
	// 超大离散范围不逐点展开；只有单条连续范围或步长完全兼容的线路才能作为可靠来源。
	for _, routeConstraint := range routeConstraints {
		if routeConstraint.Min == nil || routeConstraint.Max == nil || *routeConstraint.Min > *candidate.Min || *routeConstraint.Max < *candidate.Max {
			continue
		}
		if routeConstraint.Step == nil {
			return true
		}
		startSteps := (*candidate.Min - *routeConstraint.Min) / *routeConstraint.Step
		stepRatio := step / *routeConstraint.Step
		if math.Abs(startSteps-math.Round(startSteps)) < 1e-9 && math.Abs(stepRatio-math.Round(stepRatio)) < 1e-9 {
			return true
		}
	}
	return false
}

func optionValueSupported(name string, value any, constraints []OptionConstraint) bool {
	for _, constraint := range constraints {
		if isWildcardOptionConstraint(constraint) {
			return true
		}
		if matchOptionConstraint(name, constraint, value) {
			return true
		}
	}
	return false
}

func isWildcardOptionConstraint(constraint OptionConstraint) bool {
	for _, value := range constraint.Values {
		if normalizedScalar(value) == "*" {
			return true
		}
	}
	return false
}

func continuousOptionRangeCovered(minimum float64, maximum float64, constraints []OptionConstraint) bool {
	next := minimum
	for next <= maximum+1e-9 {
		coveredUntil := next
		advanced := false
		for _, constraint := range constraints {
			if constraint.Min == nil || constraint.Max == nil || constraint.Step != nil {
				continue
			}
			if *constraint.Min <= next+1e-9 && *constraint.Max >= next-1e-9 && *constraint.Max > coveredUntil {
				coveredUntil = *constraint.Max
				advanced = true
			}
		}
		if coveredUntil >= maximum-1e-9 {
			return true
		}
		if !advanced {
			return false
		}
		next = coveredUntil
	}
	return true
}

func anyValues(values []string) OptionConstraint {
	result := make([]any, 0, len(values))
	for _, value := range values {
		result = append(result, value)
	}
	return OptionConstraint{Values: result}
}

func boolValues(supportsTrue bool) OptionConstraint {
	values := []any{false}
	if supportsTrue {
		values = append(values, true)
	}
	return OptionConstraint{Values: values}
}

func numericRange(minimum float64, maximum float64, step float64) OptionConstraint {
	return OptionConstraint{Min: &minimum, Max: &maximum, Step: &step}
}

func DecodeLegacyModelIDs(raw string) []string         { return decodeLegacyModelIDs(raw) }
func NormalizeLegacyModelIDs(values []string) []string { return normalizeLegacyModelIDs(values) }
func CapabilitySpecWithRoutePresets(spec CapabilitySpec, routes []CapabilitySpec) CapabilitySpec {
	return capabilitySpecWithRoutePresets(spec, routes)
}
func MergeCapabilityImageSize(specs []CapabilitySpec) *CapabilityImageSize {
	return mergeCapabilityImageSize(specs)
}
func CapabilityFingerprint(spec CapabilitySpec) string { return capabilityFingerprint(spec) }
func NormalizeLogicalDefaults(spec CapabilitySpec, defaults map[string]any) (map[string]any, error) {
	return normalizeLogicalDefaults(spec, defaults)
}
func ChannelModelCapabilitySpec(channelModel model.ChannelModel) (CapabilitySpec, error) {
	return channelModelCapabilitySpec(channelModel)
}
func CapabilitySpecWithVariants(spec CapabilitySpec, channelModel model.ChannelModel) CapabilitySpec {
	return capabilitySpecWithVariants(spec, channelModel)
}
func ChannelModelDefaultOptions(channelModel model.ChannelModel, spec CapabilitySpec) (map[string]any, error) {
	return channelModelDefaultOptions(channelModel, spec)
}
func ValidateProductSpecWithinRoutes(product CapabilitySpec, routeSpecs []CapabilitySpec) error {
	return validateProductSpecWithinRoutes(product, routeSpecs)
}
