package modelcatalog

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func ModelRequestIntentFromTaskInput(input map[string]any, taskType string, operation string) ModelRequestIntent {
	capability := normalizeCapability(fmt.Sprint(input["mode"]))
	if capability == "" {
		capability = capabilityFromTaskType(taskType)
	}
	intent := ModelRequestIntent{Capability: capability, Operation: strings.TrimSpace(operation), Inputs: map[string]int{}, Options: map[string]any{}}
	for inputType, key := range map[string]string{"image": "referenceImages", "video": "referenceVideos", "audio": "referenceAudios"} {
		if values, ok := input[key].([]any); ok {
			intent.Inputs[inputType] = len(values)
		}
	}
	if mask, exists := input["mask"]; exists && mask != nil {
		intent.Inputs["mask"] = 1
	}
	explicitOptions := false
	if options, ok := input["capabilityOptions"].(map[string]any); ok {
		explicitOptions = true
		for key, value := range options {
			name := canonicalCapabilityOptionName(key)
			// auto/any 表示调用方不指定质量；不能把它当作模型必须声明的
			// 枚举值，否则未列出 auto 的模型会被错误判定为参数不支持。
			if name == "quality" {
				if normalized, ok := value.(string); ok && (strings.EqualFold(strings.TrimSpace(normalized), "auto") || strings.EqualFold(strings.TrimSpace(normalized), "any")) {
					continue
				}
			}
			intent.Options[name] = normalizeModelRequestOption(name, value)
		}
	}
	if config, ok := input["config"].(map[string]any); ok && !explicitOptions {
		for key, value := range config {
			switch key {
			case "channelId", "apiFormat", "interfaceType", "baseUrl", "apiKey", "secretKey", "headers", "model", "capabilityConfig":
				continue
			default:
				canonical := canonicalCapabilityOptionName(key)
				if isCapabilityOptionFor(capability, canonical) && value != nil && strings.TrimSpace(fmt.Sprint(value)) != "" {
					intent.Options[canonical] = normalizeModelRequestOption(canonical, value)
				}
			}
		}
	}
	return intent
}

func normalizeModelRequestOption(name string, value any) any {
	canonicalName := canonicalCapabilityOptionName(name)
	if canonicalName == "quality" || canonicalName == "size" {
		if text, ok := value.(string); ok {
			return strings.ToLower(strings.TrimSpace(text))
		}
		return value
	}
	if canonicalName != "vquality" {
		return value
	}
	resolution, ok := value.(string)
	if !ok {
		return value
	}
	switch strings.ToLower(strings.TrimSpace(resolution)) {
	case "low", "480", "480p":
		return "480p"
	case "720", "720p":
		return "720p"
	case "1080", "1080p":
		return "1080p"
	case "2k", "1440", "1440p":
		return "1440p"
	case "4k", "2160", "2160p":
		return "2160p"
	default:
		return value
	}
}

func DecodeCapabilitySpec(raw string) (CapabilitySpec, error) {
	var spec CapabilitySpec
	if err := json.Unmarshal([]byte(raw), &spec); err != nil {
		return spec, kernel.BadAuthRequest("能力配置不是有效 JSON")
	}
	normalized, err := NormalizeCapabilitySpec(spec)
	if err != nil {
		return spec, err
	}
	return normalized, nil
}

func ValidateCapabilitySpec(spec CapabilitySpec) error {
	_, err := NormalizeCapabilitySpec(spec)
	return err
}

func NormalizeCapabilitySpec(spec CapabilitySpec) (CapabilitySpec, error) {
	spec.Capability = normalizeCapability(spec.Capability)
	if spec.Version != 1 {
		return spec, kernel.BadAuthRequest("能力配置 version 必须为 1")
	}
	if spec.Capability == "" {
		return spec, kernel.BadAuthRequest("能力配置必须声明 capability")
	}
	operations := make([]string, 0, len(spec.Operations))
	seenOperations := make(map[string]bool, len(spec.Operations))
	for _, operation := range spec.Operations {
		normalized := normalizeCapabilityValue(operation)
		if normalized != "" && !seenOperations[normalized] {
			seenOperations[normalized] = true
			operations = append(operations, normalized)
		}
	}
	spec.Operations = operations
	normalizedInputs := make(map[string]InputConstraint, len(spec.Inputs))
	for rawName, constraint := range spec.Inputs {
		name := normalizeCapabilityValue(rawName)
		if name == "" || constraint.Min < 0 || constraint.Max < constraint.Min {
			return spec, kernel.BadAuthRequest("输入能力范围无效")
		}
		if _, exists := normalizedInputs[name]; exists {
			return spec, kernel.BadAuthRequest("输入能力存在重复名称：" + name)
		}
		normalizedInputs[name] = constraint
	}
	spec.Inputs = normalizedInputs
	normalizedOptions := make(map[string]OptionConstraint, len(spec.Options))
	for rawName, constraint := range spec.Options {
		name := canonicalCapabilityOptionName(rawName)
		if strings.TrimSpace(name) == "" {
			return spec, kernel.BadAuthRequest("能力参数名称不能为空")
		}
		if _, exists := normalizedOptions[name]; exists {
			return spec, kernel.BadAuthRequest("能力参数存在重复别名：" + name)
		}
		hasValues := len(constraint.Values) > 0
		hasRange := constraint.Min != nil || constraint.Max != nil || constraint.Step != nil
		if !hasValues && !hasRange {
			return spec, kernel.BadAuthRequest("能力参数必须声明 values 或数值范围")
		}
		if hasValues && hasRange {
			return spec, kernel.BadAuthRequest("能力参数不能同时声明 values 和数值范围")
		}
		if hasRange && (constraint.Min == nil || constraint.Max == nil) {
			return spec, kernel.BadAuthRequest("数值范围必须同时声明 min 和 max")
		}
		if constraint.Min != nil && constraint.Max != nil && *constraint.Max < *constraint.Min {
			return spec, kernel.BadAuthRequest("能力参数数值范围无效")
		}
		if constraint.Step != nil && *constraint.Step <= 0 {
			return spec, kernel.BadAuthRequest("能力参数 step 必须大于 0")
		}
		normalizedOptions[name] = constraint
	}
	spec.Options = normalizedOptions
	return spec, nil
}

func decodeLogicalDefaults(raw string, spec CapabilitySpec) (map[string]any, error) {
	defaults := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &defaults); err != nil {
		return nil, err
	}
	return normalizeLogicalDefaults(spec, defaults)
}

func MatchCapability(spec CapabilitySpec, intent ModelRequestIntent) CapabilityMatch {
	reasons := make([]string, 0)
	if normalizeCapability(intent.Capability) != normalizeCapability(spec.Capability) {
		reasons = append(reasons, "能力类型不匹配")
	}
	if operation := normalizeCapabilityValue(intent.Operation); operation != "" && len(spec.Operations) > 0 && !containsNormalized(spec.Operations, operation) {
		reasons = append(reasons, "不支持操作 "+intent.Operation)
	}
	for inputType, count := range intent.Inputs {
		if count < 0 {
			reasons = append(reasons, "输入数量不能小于 0")
			continue
		}
		constraint, declared := spec.Inputs[inputType]
		if !declared {
			if count > 0 {
				reasons = append(reasons, "不支持 "+capabilityInputLabel(inputType)+"输入")
			}
			continue
		}
		if count < constraint.Min || count > constraint.Max {
			reasons = append(reasons, fmt.Sprintf("%s数量需在 %d-%d 之间", capabilityInputLabel(inputType), constraint.Min, constraint.Max))
		}
	}
	for inputType, constraint := range spec.Inputs {
		if intent.Inputs[inputType] < constraint.Min {
			reasons = append(reasons, fmt.Sprintf("至少需要 %d 个%s", constraint.Min, capabilityInputLabel(inputType)))
		}
	}
	for name, value := range intent.Options {
		constraint, declared := spec.Options[canonicalCapabilityOptionName(name)]
		if !declared {
			reasons = append(reasons, "不支持参数 "+capabilityOptionLabel(name))
			continue
		}
		if !matchOptionConstraint(name, constraint, value) {
			reasons = append(reasons, "参数 "+capabilityOptionLabel(name)+"超出支持范围")
		}
	}
	return CapabilityMatch{Matched: len(reasons) == 0, Reasons: reasons}
}

func capabilityInputLabel(name string) string {
	switch normalizeCapabilityValue(name) {
	case "image":
		return "参考图片"
	case "video":
		return "参考视频"
	case "audio":
		return "参考音频"
	case "mask":
		return "蒙版"
	default:
		return name
	}
}

func capabilityOptionLabel(name string) string {
	switch canonicalCapabilityOptionName(name) {
	case "size":
		return "画面尺寸"
	case "quality":
		return "生成质量"
	case "transparentBackground":
		return "透明背景"
	case "count":
		return "输出数量"
	case "videoSeconds":
		return "视频时长"
	case "vquality":
		return "输出分辨率"
	case "videoGenerateAudio":
		return "同步音频"
	case "videoWatermark":
		return "水印设置"
	case "audioVoice":
		return "音色"
	case "audioFormat":
		return "音频格式"
	case "audioSpeed":
		return "语速"
	case "audioInstructions":
		return "朗读指令"
	default:
		return name
	}
}

func matchOptionConstraint(name string, constraint OptionConstraint, value any) bool {
	if len(constraint.Values) > 0 {
		for _, candidate := range constraint.Values {
			if normalizedScalar(candidate) == "*" {
				return true
			}
			if capabilityOptionValuesEqual(name, candidate, value) {
				return true
			}
		}
		return false
	}
	number, ok := numericScalar(value)
	if !ok {
		return false
	}
	if constraint.Min != nil && number < *constraint.Min {
		return false
	}
	if constraint.Max != nil && number > *constraint.Max {
		return false
	}
	if constraint.Step != nil && constraint.Min != nil {
		steps := (number - *constraint.Min) / *constraint.Step
		return math.Abs(steps-math.Round(steps)) < 1e-9
	}
	return true
}

func capabilityOptionValuesEqual(name string, candidate any, value any) bool {
	left := normalizedScalar(candidate)
	right := normalizedScalar(value)
	if canonicalCapabilityOptionName(name) == "vquality" {
		// Compare using the same aliases as request intents and upstream variants.
		left = strings.TrimSuffix(normalizedScalar(normalizeModelRequestOption(name, left)), "p")
		right = strings.TrimSuffix(normalizedScalar(normalizeModelRequestOption(name, right)), "p")
	}
	return left == right
}

func normalizedScalar(value any) string {
	switch typed := value.(type) {
	case string:
		return normalizeCapabilityValue(typed)
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(typed), 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	default:
		encoded, _ := json.Marshal(value)
		return string(encoded)
	}
}

func numericScalar(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func containsNormalized(values []string, expected string) bool {
	for _, value := range values {
		if normalizeCapabilityValue(value) == expected {
			return true
		}
	}
	return false
}

func normalizeCapabilityValue(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func canonicalCapabilityOptionName(value string) string {
	name := strings.TrimSpace(value)
	switch name {
	case "duration":
		return "videoSeconds"
	case "aspectRatio":
		return "size"
	case "resolution":
		return "vquality"
	default:
		return name
	}
}

func isCapabilityOptionFor(capability string, name string) bool {
	switch normalizeCapability(capability) {
	case "image":
		return name == "size" || name == "quality" || name == "transparentBackground" || name == "count"
	case "video":
		return name == "size" || name == "videoSeconds" || name == "vquality" || name == "videoGenerateAudio" || name == "videoWatermark"
	case "audio":
		return name == "audioVoice" || name == "audioFormat" || name == "audioSpeed" || name == "audioInstructions"
	case "text":
		// systemPrompt 是请求内容，不是供应线路能力维度，不能参与路由匹配。
		return false
	default:
		return false
	}
}

func isProviderCapabilityOption(name string) bool {
	return isCapabilityOptionFor("image", name) || isCapabilityOptionFor("video", name) || isCapabilityOptionFor("audio", name) || isCapabilityOptionFor("text", name)
}

func channelModelVariantForIntent(channelModel model.ChannelModel, intent ModelRequestIntent) *model.ChannelModelVariant {
	selector := skuSelectorForIntent(intent)
	bestScore := -1
	var best *model.ChannelModelVariant
	for index := range channelModel.Variants {
		tier := &channelModel.Variants[index]
		if !tier.Enabled {
			continue
		}
		matched, score := matchSKUSelector(skuSelectorForTier(*tier), selector)
		if !matched {
			continue
		}
		if score > bestScore {
			best, bestScore = tier, score
		}
	}
	return best
}

func skuSelectorForIntent(intent ModelRequestIntent) map[string]string {
	selector := map[string]string{}
	if operation := strings.ToLower(strings.TrimSpace(intent.Operation)); operation != "" {
		selector["operation"] = operation
	}
	switch normalizeCapability(intent.Capability) {
	case "video":
		// 变体按实际参考素材归类。供应商执行仍可使用 reference_to_video、extend
		// 等细分操作；选择变体时视频参考优先归为视频生视频，其余图片参考无论数量
		// 都归为图生视频。
		if intent.Inputs["video"] > 0 {
			selector["operation"] = "video_to_video"
		} else if intent.Inputs["image"] > 0 {
			selector["operation"] = "image_to_video"
		}
		if count := intent.Inputs["image"]; count > 0 {
			selector["imageCount"] = strconv.Itoa(count)
		}
		if value := normalizeChannelModelTierResolution(fmt.Sprint(intent.Options["vquality"])); value != "*" {
			selector["vquality"] = value
		}
		if seconds, err := strconv.Atoi(strings.TrimSpace(fmt.Sprint(intent.Options["videoSeconds"]))); err == nil && seconds > 0 {
			selector["videoSeconds"] = strconv.Itoa(seconds)
		}
	case "image":
		if intent.Inputs["image"] > 0 {
			selector["operation"] = "image_to_image"
		} else {
			selector["operation"] = "text_to_image"
		}
		rawQuality, _ := intent.Options["quality"].(string)
		rawSize, _ := intent.Options["size"].(string)
		if quality := normalizeImagePriceQuality(rawQuality, rawSize); quality != "" {
			selector["quality"] = quality
		}
		for _, key := range []string{"quality", "size"} {
			if key == "quality" && selector["quality"] != "" {
				continue
			}
			text, _ := intent.Options[key].(string)
			if value := strings.ToLower(strings.TrimSpace(text)); value != "" && value != "auto" && value != "any" {
				selector[key] = value
			}
		}
	}
	return selector
}

func normalizeImagePriceQuality(rawQuality string, rawSize string) string {
	quality := strings.ToLower(strings.TrimSpace(rawQuality))
	if quality != "" && quality != "auto" && quality != "any" {
		return quality
	}
	parts := strings.Split(strings.ToLower(strings.TrimSpace(rawSize)), "x")
	if len(parts) != 2 {
		return ""
	}
	width, widthErr := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
	height, heightErr := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
	if widthErr != nil || heightErr != nil || width <= 0 || height <= 0 || width > (1<<32)/height {
		return ""
	}
	pixels := width * height
	switch {
	case pixels <= 2_000_000:
		return "1k"
	case pixels <= 4_300_000:
		return "2k"
	case pixels <= 8_294_400:
		return "4k"
	default:
		return ""
	}
}

func skuSelectorForTier(tier model.ChannelModelVariant) map[string]string {
	selector := model.DecodeSKUSelector(tier.SelectorJSON)
	if len(selector) == 0 {
		if resolution := normalizeChannelModelTierResolution(tier.Resolution); resolution != "*" {
			selector["vquality"] = resolution
		}
		if tier.VideoSeconds > 0 {
			selector["videoSeconds"] = strconv.Itoa(tier.VideoSeconds)
		}
	}
	return selector
}

func matchSKUSelector(tier map[string]string, requested map[string]string) (bool, int) {
	score := 0
	for key, expected := range tier {
		expected = strings.TrimSpace(expected)
		if expected == "" || expected == "*" {
			continue
		}
		if requested[key] != expected {
			return false, 0
		}
		score++
	}
	return true, score
}

func mergeIntentDefaults(options map[string]any, defaults map[string]any) map[string]any {
	result := make(map[string]any, len(defaults)+len(options))
	for key, value := range defaults {
		result[key] = value
	}
	for key, value := range options {
		result[key] = value
	}
	return result
}

func ChannelModelVariantForIntent(channelModel model.ChannelModel, intent ModelRequestIntent) *model.ChannelModelVariant {
	return channelModelVariantForIntent(channelModel, intent)
}

func SKUSelectorForIntent(intent ModelRequestIntent) map[string]string {
	return skuSelectorForIntent(intent)
}

func SKUSelectorForTier(tier model.ChannelModelVariant) map[string]string {
	return skuSelectorForTier(tier)
}

func MatchSKUSelector(tier map[string]string, requested map[string]string) (bool, int) {
	return matchSKUSelector(tier, requested)
}

func MergeIntentDefaults(options map[string]any, defaults map[string]any) map[string]any {
	return mergeIntentDefaults(options, defaults)
}

func CanonicalCapabilityOptionName(value string) string {
	return canonicalCapabilityOptionName(value)
}

func NormalizeModelRequestOption(name string, value any) any {
	return normalizeModelRequestOption(name, value)
}

func IsCapabilityOptionFor(capability string, name string) bool {
	return isCapabilityOptionFor(capability, name)
}

func IsProviderCapabilityOption(name string) bool {
	return isProviderCapabilityOption(name)
}

func CapabilityOptionValuesEqual(name string, candidate any, value any) bool {
	return capabilityOptionValuesEqual(name, candidate, value)
}
