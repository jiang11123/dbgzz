package protocol

import "strings"

// NormalizeSeedanceTaskOptions applies only explicit task intent, never guesses
// edit/extend intent from free-form prompts. See the official Seedance 2.5 guide.
func NormalizeSeedanceTaskOptions(r GenerationRequest) GenerationRequest {
	m := strings.ToLower(r.Model)
	if !(strings.HasSuffix(m, "seedance-2.5") || strings.Contains(m, "seedance-2.5-") || strings.HasSuffix(m, "seedance-2-5") || strings.Contains(m, "seedance-2-5-")) {
		return r
	}
	locked := false
	for _, media := range r.Images {
		locked = locked || media.Role == "first_frame" || media.Role == "last_frame"
	}
	if len(r.Videos) > 0 {
		switch r.Operation {
		case "extend":
			locked = true
		case "inpaint", "replace_element", "style_transfer":
			locked = true
			r.Duration = -1
		}
	}
	if locked {
		r.AspectRatio = "adaptive"
	}
	r.Output.AspectRatio, r.Output.Duration = r.AspectRatio, r.Duration
	return r
}

// SeedanceOmniTaskType preserves explicit operation intent at the wire boundary.
func SeedanceOmniTaskType(r GenerationRequest) string {
	m := strings.ToLower(r.Model)
	if !(strings.HasSuffix(m, "seedance-2.5") || strings.Contains(m, "seedance-2.5-") || strings.HasSuffix(m, "seedance-2-5") || strings.Contains(m, "seedance-2-5-")) {
		return ""
	}
	switch r.Operation {
	case "reference_to_video":
		return "reference"
	case "extend":
		if len(r.Videos) > 0 {
			return "extend"
		}
	case "inpaint", "replace_element", "style_transfer":
		if len(r.Videos) > 0 {
			return "edit"
		}
	}
	return ""
}
