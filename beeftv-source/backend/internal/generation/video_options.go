package generation

import (
	"context"
	"net/url"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/providerpreset"
)

func beefAPITestBaseURL(ctx context.Context) string {
	runtime, ok := RuntimeFromContext(ctx)
	if !ok {
		return ""
	}
	return strings.TrimSpace(runtime.Endpoints.BeefAPIVideoBaseURL)
}

func IsPublicMediaURL(value string) bool {
	lower := strings.ToLower(value)
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

func IsSeedanceVideoConfig(config Config) bool {
	modelName := strings.ToLower(config.Model)
	return strings.Contains(modelName, "seedance") || strings.Contains(modelName, "doubao-seedance") || IsArkPlanVideoConfig(config)
}

// Empty interface types use the legacy hand-written Seedance task path.
// Explicit third-party protocols own their image roles and parameter shape.
func usesSeedanceTaskOptions(config Config) bool {
	return strings.TrimSpace(config.InterfaceType) == "" ||
		model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(config.InterfaceType)) ||
		config.InterfaceType == "seedance-videos-compatible"
}

func IsBeefAPIVideoConfig(ctx context.Context, config Config) bool {
	if testBase := beefAPITestBaseURL(ctx); testBase != "" {
		got := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
		want := strings.TrimRight(testBase, "/")
		return got == want || strings.HasPrefix(got, want+"/")
	}
	if providerpreset.IsBeefAPIEndpoint(config.BaseURL) {
		return true
	}
	// The domestic gateway uses the same video wire contract. This only selects
	// the request format; hosted-account credential ownership stays unchanged.
	u, err := url.Parse(strings.TrimSpace(config.BaseURL))
	return err == nil && u.Scheme == "https" && strings.EqualFold(u.Hostname(), "beefapi.com") && u.User == nil && (u.Port() == "" || u.Port() == "443")
}

func IsBeefAPISeedancePreuploadConfig(ctx context.Context, config Config) bool {
	return IsBeefAPIVideoConfig(ctx, config) && IsSeedanceVideoConfig(config)
}

func requiresBeefAPIHTTPReferences(ctx context.Context, config Config) bool {
	if UpscaleMediaType(config.Model) != "" {
		return IsBeefAPIVideoConfig(ctx, config)
	}
	contract, ok := providerpreset.BeefAPIVideoContract(config.Model)
	return ok && contract.RequiresHTTPReferences && IsBeefAPIVideoConfig(ctx, config)
}

func IsGrokVideoConfig(config Config) bool {
	return strings.Contains(strings.ToLower(strings.TrimSpace(config.Model)), "grok")
}

func IsArkPlanVideoConfig(config Config) bool {
	if !strings.Contains(strings.ToLower(config.BaseURL), "/api/plan/v3") {
		return false
	}
	// Agent Plan 图片与视频共用 /api/plan/v3；按协议排除图片，避免 Seedream 误走视频/可信素材路径。
	iface := strings.TrimSpace(config.InterfaceType)
	if iface == string(model.ChannelInterfaceVolcengineArkImage) || iface == "volcengine-ark-agent-plan-image" {
		return false
	}
	return true
}

func NormalizeImageQuality(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1k":
		return "low"
	case "2k":
		return "medium"
	case "4k":
		return "high"
	default:
		return value
	}
}

func ImageParameterSupported(profile *ImageCapabilityConfig, parameter string) bool {
	if profile == nil {
		return true
	}
	if parameter == "response_format" {
		return profile.ResponseFormat.Supported
	}
	return profile.OutputFormat.Supported
}

func ImageQualitySupported(profile *ImageCapabilityConfig) bool {
	return profile == nil || profile.Quality.Supported
}

func ImageTransparentBackgroundSupported(profile *ImageCapabilityConfig) bool {
	return profile == nil || profile.TransparentBackground.Supported
}

func ImageSizeParameter(profile *ImageCapabilityConfig, value string) (string, string) {
	if profile == nil {
		return "size", NormalizePixelSize(value)
	}
	value = strings.TrimSpace(value)
	if strings.EqualFold(value, "auto") {
		return "", ""
	}
	if value == "" {
		value = strings.TrimSpace(profile.Size.Default)
	}
	switch profile.Size.Parameter {
	case "size":
		return "size", NormalizePixelSize(value)
	case "aspect_ratio":
		return "aspect_ratio", NormalizeImageAspectRatio(value)
	default:
		return "", ""
	}
}

func NormalizeImageAspectRatio(value string) string {
	value = strings.TrimSpace(strings.ToLower(strings.ReplaceAll(value, "×", "x")))
	if strings.Contains(value, ":") {
		return value
	}
	parts := strings.Split(value, "x")
	if len(parts) != 2 {
		return ""
	}
	width, widthErr := strconv.Atoi(parts[0])
	height, heightErr := strconv.Atoi(parts[1])
	if widthErr != nil || heightErr != nil || width <= 0 || height <= 0 {
		return ""
	}
	divisor := ImageDimensionGCD(width, height)
	return strconv.Itoa(width/divisor) + ":" + strconv.Itoa(height/divisor)
}

func ImageDimensionGCD(left int, right int) int {
	for right != 0 {
		left, right = right, left%right
	}
	if left < 1 {
		return 1
	}
	return left
}

func NormalizePixelSize(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "auto" {
		return ""
	}
	// 画布按比例保存常用预设；图片接口只接受像素尺寸，必须在请求边界完成转换。
	switch value {
	case "1:1":
		return "1024x1024"
	case "3:2":
		return "1536x1024"
	case "2:3":
		return "1024x1536"
	case "4:3":
		return "1360x1024"
	case "3:4":
		return "1024x1360"
	case "16:9":
		return "1824x1024"
	case "9:16":
		return "1024x1824"
	case "21:9":
		return "2352x1008"
	}
	if strings.Contains(value, "x") {
		return value
	}
	return ""
}

func NormalizeVideoSize(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "auto" {
		return ""
	}
	if strings.Contains(value, "x") {
		return value
	}
	if value == "9:16" || value == "2:3" || value == "3:4" {
		return "720x1280"
	}
	return "1280x720"
}

func NormalizeVideoResolution(value string) string {
	return modelcatalog.NormalizeVideoResolution(value)
}

func NormalizeSeedanceDuration(value string) int {
	if strings.TrimSpace(value) == "-1" {
		return -1
	}
	seconds, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || seconds <= 0 {
		return 5
	}
	return seconds
}

func NormalizeSeedanceVideosDuration(value string) int {
	return NormalizeSeedanceDuration(value)
}

func NormalizeSeedanceRatio(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "auto" || value == "adaptive" {
		return "adaptive"
	}
	switch value {
	case "16:9", "9:16", "1:1", "4:3", "3:4", "21:9":
		return value
	default:
		return "adaptive"
	}
}

func NormalizeSeedanceVideosRatio(value string) string {
	return NormalizeSeedanceRatio(value)
}

func NormalizeSeedanceResolution(value string, _ string) string {
	trimmed := strings.TrimSpace(value)
	lower := strings.ToLower(trimmed)
	if isAutomaticVideoResolution(trimmed) {
		return "720p"
	}
	if lower == "low" {
		return "480p"
	}
	if lower == "4k" {
		return "2160p"
	}
	if lower == "2k" {
		return "1440p"
	}
	resolution := strings.TrimSuffix(lower, "p")
	if _, err := strconv.Atoi(resolution); err == nil {
		return resolution + "p"
	}
	return trimmed
}

func ParseBool(value string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true":
		return true
	case "false":
		return false
	default:
		return fallback
	}
}

func ParseFloat(value string, fallback float64) float64 {
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil || number == 0 {
		return fallback
	}
	return number
}

func SleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
