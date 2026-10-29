package depthcapture

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

func PrepareInput(resourceID string, resource *model.Resource) ([]byte, error) {
	resourceID = strings.TrimSpace(resourceID)
	if resourceID == "" {
		return nil, ErrNeedVideo
	}
	if resource == nil {
		return nil, ErrMissingVideo
	}
	if !strings.HasPrefix(resource.MimeType, "video/") {
		return nil, ErrNotVideo
	}
	return json.Marshal(Input{ResourceID: resourceID, Profile: StandardProfile})
}

func ParseInput(raw string) (Input, error) {
	var input Input
	if err := json.Unmarshal([]byte(raw), &input); err != nil || strings.TrimSpace(input.ResourceID) == "" {
		return Input{}, ErrBadInput
	}
	input.ResourceID = strings.TrimSpace(input.ResourceID)
	if input.Profile == "" {
		input.Profile = StandardProfile
	}
	return input, nil
}

func OverDuration(durationMs int64) bool {
	return durationMs > MaxDurationMs
}
