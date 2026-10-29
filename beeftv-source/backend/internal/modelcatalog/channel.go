package modelcatalog

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

const maxAdminChannelModelBatchDeleteCount = 100

func validateChannelModelTierCapabilities(tiers []model.ChannelModelVariant, rawCapabilityConfig string, capability string) error {
	if capability != "video" {
		return nil
	}
	config, err := DecodeModelCapabilityConfig(rawCapabilityConfig)
	if err != nil || config == nil || config.Video == nil {
		return kernel.BadAuthRequest("视频模型能力配置无效，无法校验变体规格")
	}
	resolutionSupported := make(map[string]bool, len(config.Video.Resolutions))
	for _, resolution := range config.Video.Resolutions {
		resolutionSupported[normalizeChannelModelTierResolution(resolution)] = true
	}
	durationSupported := make(map[int]bool, len(config.Video.Duration.Values))
	for _, seconds := range config.Video.Duration.Values {
		durationSupported[seconds] = true
	}
	for _, tier := range tiers {
		if tier.Resolution != "*" && !resolutionSupported[normalizeChannelModelTierResolution(tier.Resolution)] {
			return kernel.BadAuthRequest("变体分辨率不在该视频模型支持范围内：" + tier.Resolution)
		}
		if tier.VideoSeconds == 0 {
			continue
		}
		if !videoDurationSupported(config.Video) {
			continue
		}
		if config.Video.Duration.Selection == "enum" && !durationSupported[tier.VideoSeconds] {
			return kernel.BadAuthRequest(fmt.Sprintf("变体时长 %d 秒不在该视频模型支持范围内", tier.VideoSeconds))
		}
		if config.Video.Duration.Selection == "range" && !videoDurationAllowed(config.Video.Duration, tier.VideoSeconds) {
			return kernel.BadAuthRequest(fmt.Sprintf("变体时长 %d 秒不在该视频模型支持范围内", tier.VideoSeconds))
		}
	}
	return nil
}

func normalizeChannelModelTierSelector(capability string, input ChannelModelVariantRequest) (map[string]string, string, int, error) {
	selector := make(map[string]string, len(input.Selector)+3)
	for rawKey, rawValue := range input.Selector {
		key := strings.TrimSpace(rawKey)
		value := strings.TrimSpace(rawValue)
		if key == "" || value == "" {
			continue
		}
		switch key {
		case "operation":
			value = strings.ToLower(value)
		case "quality", "size":
			value = strings.ToLower(value)
			if value == "auto" || value == "any" {
				value = "*"
			}
		case "vquality":
			value = normalizeChannelModelTierResolution(value)
		case "videoSeconds":
			seconds, err := strconv.Atoi(value)
			if err != nil || seconds < 0 {
				return nil, "", 0, kernel.BadAuthRequest("视频变体时长必须是非负整数")
			}
			if seconds == 0 {
				continue
			}
			value = strconv.Itoa(seconds)
		case "imageCount":
			count, err := strconv.Atoi(value)
			if err != nil || count < 0 {
				return nil, "", 0, kernel.BadAuthRequest("参考图片数量必须是非负整数")
			}
			if count == 0 {
				continue
			}
			value = strconv.Itoa(count)
		default:
			return nil, "", 0, kernel.BadAuthRequest("模型变体不支持规格字段：" + key)
		}
		selector[key] = value
	}
	if capability == "video" {
		if _, exists := selector["vquality"]; !exists {
			if resolution := normalizeChannelModelTierResolution(input.Resolution); resolution != "*" {
				selector["vquality"] = resolution
			}
		}
		if _, exists := selector["videoSeconds"]; !exists && input.VideoSeconds > 0 {
			selector["videoSeconds"] = strconv.Itoa(input.VideoSeconds)
		}
	} else if input.Resolution != "" && normalizeChannelModelTierResolution(input.Resolution) != "*" {
		return nil, "", 0, kernel.BadAuthRequest("非视频模型不能使用视频分辨率变体")
	} else if input.VideoSeconds != 0 {
		return nil, "", 0, kernel.BadAuthRequest("非视频模型不能使用视频时长变体")
	}
	for _, key := range []string{"quality", "size"} {
		if _, exists := selector[key]; exists && capability != "image" {
			return nil, "", 0, kernel.BadAuthRequest("只有图片模型可以按 " + key + " 配置变体")
		}
	}
	if _, exists := selector["vquality"]; exists && capability != "video" {
		return nil, "", 0, kernel.BadAuthRequest("只有视频模型可以按分辨率配置变体")
	}
	if _, exists := selector["videoSeconds"]; exists && capability != "video" {
		return nil, "", 0, kernel.BadAuthRequest("只有视频模型可以按时长配置变体")
	}
	if _, exists := selector["imageCount"]; exists && capability != "video" {
		return nil, "", 0, kernel.BadAuthRequest("只有视频模型可以按参考图片数量配置变体")
	}
	resolution := "*"
	if value := selector["vquality"]; value != "" {
		resolution = value
	}
	videoSeconds := 0
	if value := selector["videoSeconds"]; value != "" {
		videoSeconds, _ = strconv.Atoi(value)
	}
	return selector, resolution, videoSeconds, nil
}

func normalizeChannelModelTierResolution(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" || value == "*" || strings.EqualFold(value, "any") {
		return "*"
	}
	normalized := normalizeModelRequestOption("vquality", value)
	return strings.ToLower(strings.TrimSpace(fmt.Sprint(normalized)))
}

func videoTestDefaults(profile *VideoCapabilityConfig) (string, string) {
	if profile == nil {
		return "16:9", "720"
	}
	ratio := strings.TrimSpace(profile.DefaultRatio)
	if ratio == "" && len(profile.Ratios) > 0 {
		ratio = strings.TrimSpace(profile.Ratios[0])
	}
	if ratio == "" {
		ratio = "16:9"
	}
	resolution := strings.TrimSpace(profile.DefaultResolution)
	if resolution == "" && len(profile.Resolutions) > 0 {
		resolution = strings.TrimSpace(profile.Resolutions[0])
	}
	if resolution == "" {
		resolution = "720"
	}
	return ratio, resolution
}

func imageTestDefaults(profile *ImageCapabilityConfig) (string, string) {
	if profile == nil {
		return "1024x1024", "auto"
	}
	size := ""
	if profile.Size.Parameter != "none" {
		size = strings.TrimSpace(profile.Size.Default)
	}
	quality := ""
	if profile.Quality.Supported {
		quality = strings.TrimSpace(profile.Quality.Default)
	}
	return size, quality
}

func normalizeAdminChannelModelDeleteIDs(values []string) ([]string, error) {
	result := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		id := strings.TrimSpace(value)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		result = append(result, id)
	}
	if len(result) == 0 {
		return nil, kernel.BadAuthRequest("请至少选择一个要删除的渠道模型")
	}
	if len(result) > maxAdminChannelModelBatchDeleteCount {
		return nil, kernel.BadAuthRequest("单次最多删除 100 个渠道模型")
	}
	return result, nil
}

func retiredChannelModelKeys(raw string) map[string]bool {
	var values []string
	_ = json.Unmarshal([]byte(raw), &values)
	result := make(map[string]bool, len(values))
	for _, value := range values {
		if key := channelModelCatalogKey(value); key != "" {
			result[key] = true
		}
	}
	return result
}

func channelModelCatalogKey(value string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(value), "models/"))
}

func protocolCapabilityFromMetadata(metadata ProtocolMeta) string {
	return strings.TrimSpace(metadata.PrimaryCapability)
}

func NormalizeChannelModelContract(lookup ProtocolLookup, channel *model.ModelChannel, req ChannelModelRequest) (string, string, string, model.ChannelInterfaceType, error) {
	modelKey := strings.TrimPrefix(strings.TrimSpace(req.ModelKey), "models/")
	if modelKey == "" {
		return "", "", "", "", kernel.BadAuthRequest("请填写模型标识")
	}
	providerModelKey := strings.TrimPrefix(strings.TrimSpace(req.ProviderModelKey), "models/")
	if providerModelKey == "" {
		providerModelKey = modelKey
	}
	capability := normalizeCapability(req.Capability)
	if capability == "" {
		return "", "", "", "", kernel.BadAuthRequest("请选择模型能力")
	}
	if lookup == nil {
		return "", "", "", "", kernel.BadAuthRequest("请选择有效的模型请求协议")
	}
	meta, ok := lookup(strings.TrimSpace(req.Protocol))
	if !ok || !meta.Enabled || meta.UnavailableReason != "" {
		return "", "", "", "", kernel.BadAuthRequest("请选择有效的模型请求协议")
	}
	protocol := model.ChannelInterfaceType(meta.ID)
	if expected := protocolCapabilityFromMetadata(meta); expected != "" && expected != capability {
		return "", "", "", "", kernel.BadAuthRequest("模型能力与请求协议不匹配")
	}
	if channel != nil && (protocol == model.ChannelInterfaceVolcengineJiMengImage || protocol == model.ChannelInterfaceVolcengineJiMengVideo) && (strings.TrimSpace(channel.APIKey) == "" || strings.TrimSpace(channel.SecretKey) == "") {
		return "", "", "", "", kernel.BadAuthRequest("即梦官方协议需要先在渠道中配置 Access Key 和 Secret Key")
	}
	return modelKey, providerModelKey, capability, protocol, nil
}

func NormalizeChannelModelVariants(req ChannelModelRequest, capability string, protocol model.ChannelInterfaceType, fallbackProviderModelKey string) ([]model.ChannelModelVariant, error) {
	_ = protocol
	inputs := req.Variants
	if len(inputs) == 0 {
		enabled := true
		inputs = []ChannelModelVariantRequest{{
			Resolution: "*", VideoSeconds: 0, ProviderModelKey: fallbackProviderModelKey, Enabled: &enabled,
		}}
	}
	result := make([]model.ChannelModelVariant, 0, len(inputs))
	seen := make(map[string]bool, len(inputs))
	for _, input := range inputs {
		selector, resolution, videoSeconds, selectorErr := normalizeChannelModelTierSelector(capability, input)
		if selectorErr != nil {
			return nil, selectorErr
		}
		_, key, keyErr := model.CanonicalSKUSelector(selector)
		if keyErr != nil {
			return nil, keyErr
		}
		if seen[key] {
			return nil, kernel.BadAuthRequest("同一个操作和规格组合只能配置一个上游变体")
		}
		seen[key] = true
		enabled := input.Enabled == nil || *input.Enabled
		result = append(result, model.ChannelModelVariant{
			SelectorKey:      key,
			SelectorJSON:     key,
			Selector:         selector,
			Resolution:       resolution,
			VideoSeconds:     videoSeconds,
			ProviderModelKey: strings.TrimPrefix(strings.TrimSpace(kernel.FirstNonEmpty(input.ProviderModelKey, fallbackProviderModelKey)), "models/"),
			Enabled:          enabled,
		})
	}
	return result, nil
}

func CascadeUpstreamRename(tiers []model.ChannelModelVariant, previousProviderModelKey, providerModelKey string) []model.ChannelModelVariant {
	previousProviderModelKey = strings.TrimPrefix(strings.TrimSpace(previousProviderModelKey), "models/")
	providerModelKey = strings.TrimPrefix(strings.TrimSpace(providerModelKey), "models/")
	if previousProviderModelKey == "" || providerModelKey == "" || previousProviderModelKey == providerModelKey {
		return tiers
	}
	for index := range tiers {
		if strings.TrimPrefix(strings.TrimSpace(tiers[index].ProviderModelKey), "models/") == previousProviderModelKey {
			tiers[index].ProviderModelKey = providerModelKey
		}
	}
	return tiers
}

func ValidateChannelModelTierCapabilities(tiers []model.ChannelModelVariant, rawCapabilityConfig string, capability string) error {
	return validateChannelModelTierCapabilities(tiers, rawCapabilityConfig, capability)
}

func NormalizeChannelModelTierSelector(capability string, input ChannelModelVariantRequest) (map[string]string, string, int, error) {
	return normalizeChannelModelTierSelector(capability, input)
}

func NormalizeChannelModelTierResolution(raw string) string {
	return normalizeChannelModelTierResolution(raw)
}

func VideoTestDefaults(profile *VideoCapabilityConfig) (string, string) {
	return videoTestDefaults(profile)
}

func ImageTestDefaults(profile *ImageCapabilityConfig) (string, string) {
	return imageTestDefaults(profile)
}

func NormalizeAdminChannelModelDeleteIDs(values []string) ([]string, error) {
	return normalizeAdminChannelModelDeleteIDs(values)
}

func RetiredChannelModelKeys(raw string) map[string]bool {
	return retiredChannelModelKeys(raw)
}

func ChannelModelCatalogKey(value string) string {
	return channelModelCatalogKey(value)
}

func ProtocolCapabilityFromMetadata(metadata ProtocolMeta) string {
	return protocolCapabilityFromMetadata(metadata)
}
