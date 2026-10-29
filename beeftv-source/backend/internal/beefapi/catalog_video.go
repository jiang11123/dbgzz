package beefapi

import (
	"encoding/json"
	"math"
	"strings"
)

// NormalizeCatalogVideoCapability copies a gateway video_capabilities object
// using the existing BeefTV VideoCapabilityConfig field names and bounds.
// Omitted nested limits stay omitted so callers do not persist implicit zeros.
func NormalizeCatalogVideoCapability(raw json.RawMessage) (map[string]any, bool) {
	if len(strings.TrimSpace(string(raw))) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return nil, false
	}
	var payload any
	if json.Unmarshal(raw, &payload) != nil {
		return nil, false
	}
	object, ok := payload.(map[string]any)
	if !ok || !catalogNumbersFinite(payload) {
		return nil, false
	}
	references, ok := catalogObject(object, "references")
	if !ok {
		return nil, false
	}
	duration, ok := catalogObject(object, "duration")
	if !ok {
		return nil, false
	}
	generateAudio, ok := catalogBooleanConfig(object, "generateAudio")
	if !ok {
		return nil, false
	}
	watermark, ok := catalogBooleanConfig(object, "watermark")
	if !ok {
		return nil, false
	}
	ratios, ok := catalogStringList(object["ratios"], true)
	if !ok {
		return nil, false
	}
	resolutions, ok := catalogStringList(object["resolutions"], true)
	if !ok {
		return nil, false
	}
	operations, ok := catalogStringList(object["operations"], false)
	if !ok || len(operations) == 0 {
		return nil, false
	}
	defaultRatio, ok := catalogString(object["defaultRatio"])
	if !ok {
		return nil, false
	}
	defaultResolution, ok := catalogString(object["defaultResolution"])
	if !ok {
		return nil, false
	}
	defaultOperation, ok := catalogString(object["defaultOperation"])
	if !ok || defaultOperation == "" || !containsCatalogString(operations, defaultOperation) {
		return nil, false
	}
	if len(ratios) == 0 {
		if defaultRatio != "" {
			return nil, false
		}
	} else if defaultRatio == "" || !containsCatalogString(ratios, defaultRatio) {
		return nil, false
	}
	if len(resolutions) == 0 {
		if defaultResolution != "" {
			return nil, false
		}
	} else if defaultResolution == "" || !containsCatalogString(resolutions, defaultResolution) {
		return nil, false
	}
	normalizedDuration, ok := normalizeCatalogDuration(duration)
	if !ok {
		return nil, false
	}
	normalizedRefs, ok := normalizeCatalogReferences(references)
	if !ok {
		return nil, false
	}
	video := map[string]any{
		"references":        normalizedRefs,
		"duration":          normalizedDuration,
		"ratios":            ratios,
		"defaultRatio":      defaultRatio,
		"resolutions":       resolutions,
		"defaultResolution": defaultResolution,
		"generateAudio":     generateAudio,
		"watermark":         watermark,
		"operations":        operations,
		"defaultOperation":  defaultOperation,
	}
	if rawSupported, present := object["durationSupported"]; present {
		supported, ok := rawSupported.(bool)
		if !ok {
			return nil, false
		}
		video["durationSupported"] = supported
	}
	return video, true
}

func normalizeCatalogReferences(input map[string]any) (map[string]any, bool) {
	refs := map[string]any{}
	intFields := map[string][2]int{
		"promptMaxChars":               {0, 1000000},
		"promptMaxUtf16Units":          {0, 1000000},
		"minImages":                    {0, 100},
		"maxImages":                    {0, 100},
		"maxVideos":                    {0, 100},
		"maxAudios":                    {0, 100},
		"maxVideoDurationSeconds":      {0, math.MaxInt32},
		"minVideoDurationSeconds":      {0, math.MaxInt32},
		"maxAudioDurationSeconds":      {0, math.MaxInt32},
		"maxAudioTotalDurationSeconds": {0, math.MaxInt32},
		"maxVideoTotalDurationSeconds": {0, math.MaxInt32},
		"minImageWidth":                {0, math.MaxInt32},
		"maxImageWidth":                {0, math.MaxInt32},
		"minImageHeight":               {0, math.MaxInt32},
		"maxImageHeight":               {0, math.MaxInt32},
		"minVideoWidth":                {0, math.MaxInt32},
		"maxVideoWidth":                {0, math.MaxInt32},
		"minVideoHeight":               {0, math.MaxInt32},
		"maxVideoHeight":               {0, math.MaxInt32},
	}
	int64Fields := []string{"maxImageBytes", "maxVideoBytes", "maxAudioBytes", "minImagePixels", "maxImagePixels", "minVideoPixels", "maxVideoPixels"}
	floatFields := []string{"minImageAspect", "maxImageAspect", "minVideoAspect", "maxVideoAspect", "minAudioDurationSeconds"}
	for key, bounds := range intFields {
		value, present, ok := catalogIntField(input, key)
		if !ok {
			return nil, false
		}
		if !present {
			continue
		}
		if value < bounds[0] || value > bounds[1] {
			return nil, false
		}
		refs[key] = value
	}
	for _, key := range int64Fields {
		value, present, ok := catalogInt64Field(input, key)
		if !ok {
			return nil, false
		}
		if !present {
			continue
		}
		if value < 0 {
			return nil, false
		}
		refs[key] = value
	}
	for _, key := range floatFields {
		value, present, ok := catalogFloatField(input, key)
		if !ok {
			return nil, false
		}
		if !present {
			continue
		}
		if value < 0 {
			return nil, false
		}
		refs[key] = value
	}
	minImages, hasMin := catalogPresentInt(refs, "minImages")
	maxImages, hasMax := catalogPresentInt(refs, "maxImages")
	if hasMin && hasMax && minImages > maxImages {
		return nil, false
	}
	minVideo, hasMinVideo := catalogPresentInt(refs, "minVideoDurationSeconds")
	maxVideo, hasMaxVideo := catalogPresentInt(refs, "maxVideoDurationSeconds")
	if hasMinVideo && hasMaxVideo && maxVideo > 0 && minVideo > maxVideo {
		return nil, false
	}
	minAudio, hasMinAudio := catalogPresentFloat(refs, "minAudioDurationSeconds")
	maxAudio, hasMaxAudio := catalogPresentInt(refs, "maxAudioDurationSeconds")
	if hasMinAudio && hasMaxAudio && maxAudio > 0 && minAudio > float64(maxAudio) {
		return nil, false
	}
	return refs, true
}

func normalizeCatalogDuration(input map[string]any) (map[string]any, bool) {
	selection, ok := catalogString(input["selection"])
	if !ok || (selection != "range" && selection != "enum") {
		return nil, false
	}
	defaultValue, present, ok := catalogIntField(input, "default")
	if !ok || !present {
		return nil, false
	}
	duration := map[string]any{"selection": selection, "default": defaultValue}
	switch selection {
	case "range":
		min, hasMin, ok := catalogIntField(input, "min")
		if !ok || !hasMin {
			return nil, false
		}
		max, hasMax, ok := catalogIntField(input, "max")
		if !ok || !hasMax {
			return nil, false
		}
		step, hasStep, ok := catalogIntField(input, "step")
		if !ok || !hasStep {
			return nil, false
		}
		if min < 1 || max < min || max > 3600 || step < 1 || defaultValue < min || defaultValue > max || (defaultValue-min)%step != 0 {
			return nil, false
		}
		duration["min"], duration["max"], duration["step"] = min, max, step
	case "enum":
		rawValues, ok := input["values"].([]any)
		if !ok || len(rawValues) == 0 || len(rawValues) > 100 {
			return nil, false
		}
		values := make([]int, 0, len(rawValues))
		seen := map[int]bool{}
		for _, raw := range rawValues {
			value, ok := catalogWholeInt(raw)
			if !ok || (value < 1 && value != -1) || value > 3600 || seen[value] {
				return nil, false
			}
			seen[value] = true
			values = append(values, value)
		}
		if !seen[defaultValue] {
			return nil, false
		}
		duration["values"] = values
	}
	return duration, true
}

func catalogBooleanConfig(object map[string]any, key string) (map[string]any, bool) {
	child, ok := catalogObject(object, key)
	if !ok {
		return nil, false
	}
	supported, ok := child["supported"].(bool)
	if !ok {
		return nil, false
	}
	defaultValue, ok := child["default"].(bool)
	if !ok {
		return nil, false
	}
	return map[string]any{"supported": supported, "default": defaultValue}, true
}

func catalogObject(object map[string]any, key string) (map[string]any, bool) {
	child, ok := object[key].(map[string]any)
	return child, ok
}

func catalogString(value any) (string, bool) {
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	return strings.TrimSpace(text), true
}

func catalogStringList(value any, allowEmpty bool) ([]string, bool) {
	items, ok := value.([]any)
	if !ok {
		return nil, false
	}
	result := make([]string, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		text, ok := catalogString(item)
		if !ok {
			return nil, false
		}
		if text == "" || seen[text] {
			continue
		}
		seen[text] = true
		result = append(result, text)
	}
	if !allowEmpty && len(result) == 0 {
		return nil, false
	}
	return result, true
}

func catalogIntField(object map[string]any, key string) (int, bool, bool) {
	raw, present := object[key]
	if !present {
		return 0, false, true
	}
	value, ok := catalogWholeInt(raw)
	return value, true, ok
}

func catalogInt64Field(object map[string]any, key string) (int64, bool, bool) {
	raw, present := object[key]
	if !present {
		return 0, false, true
	}
	value, ok := catalogWholeInt64(raw)
	return value, true, ok
}

func catalogFloatField(object map[string]any, key string) (float64, bool, bool) {
	raw, present := object[key]
	if !present {
		return 0, false, true
	}
	value, ok := catalogFiniteFloat(raw)
	return value, true, ok
}

func catalogPresentInt(object map[string]any, key string) (int, bool) {
	value, ok := object[key].(int)
	return value, ok
}

func catalogPresentFloat(object map[string]any, key string) (float64, bool) {
	switch typed := object[key].(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	default:
		return 0, false
	}
}

func catalogWholeInt(value any) (int, bool) {
	number, ok := catalogFiniteFloat(value)
	if !ok || number != math.Trunc(number) || number < math.MinInt || number > math.MaxInt {
		return 0, false
	}
	return int(number), true
}

func catalogWholeInt64(value any) (int64, bool) {
	number, ok := catalogFiniteFloat(value)
	if !ok || number != math.Trunc(number) || number < math.MinInt64 || number > math.MaxInt64 {
		return 0, false
	}
	return int64(number), true
}

func catalogFiniteFloat(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case json.Number:
		number, err := typed.Float64()
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
			return 0, false
		}
		return number, true
	default:
		return 0, false
	}
}

func catalogNumbersFinite(value any) bool {
	switch typed := value.(type) {
	case float64:
		return !math.IsNaN(typed) && !math.IsInf(typed, 0)
	case json.Number:
		number, err := typed.Float64()
		return err == nil && !math.IsNaN(number) && !math.IsInf(number, 0)
	case map[string]any:
		for _, child := range typed {
			if !catalogNumbersFinite(child) {
				return false
			}
		}
	case []any:
		for _, child := range typed {
			if !catalogNumbersFinite(child) {
				return false
			}
		}
	}
	return true
}

func containsCatalogString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
