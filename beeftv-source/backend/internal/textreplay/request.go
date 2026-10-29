package textreplay

import "strings"

// IsRequest identifies frontend-owned text persistence (input replay=true).
// These tasks archive streamed text and do not enter the provider worker queue.
func IsRequest(input map[string]any) bool {
	if input == nil {
		return false
	}
	value, ok := input["replay"]
	if !ok {
		return false
	}
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(strings.TrimSpace(v), "true")
	default:
		return false
	}
}

// textTask matches the existing capabilityFromTaskType == "text" rule so
// storyboard/agent names stay eligible and image/video/audio stay rejected.
func textTask(taskType string) bool {
	value := strings.ToLower(taskType)
	for _, capability := range []string{"video", "image", "audio", "text"} {
		if strings.Contains(value, capability) {
			return capability == "text"
		}
	}
	return strings.Contains(value, "storyboard") || strings.Contains(value, "agent")
}
