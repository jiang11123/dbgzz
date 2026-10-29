package generation

import (
	"encoding/json"

	"infinite-canvas/backend/internal/protocol"
)

// ResolveAgentResourcePlaceholders maps generation media onto the protocol
// placeholder walk. The hydrated request is an in-memory copy and must never
// be written back to Task.InputJSON.
func ResolveAgentResourcePlaceholders(input Input, hydrate bool) (Input, error) {
	if input.AgentRequests == nil {
		return input, nil
	}
	refs := make([]protocol.MediaRef, 0, len(input.ReferenceImages))
	for _, media := range input.ReferenceImages {
		refs = append(refs, protocol.MediaRef{StorageKey: media.StorageKey, DataURL: media.DataURL, URL: media.URL})
	}
	resolved, err := protocol.ResolveProtocolPlaceholders(refs, input.AgentRequests, hydrate)
	if err != nil {
		return input, err
	}
	if !hydrate {
		return input, nil
	}
	raw, err := json.Marshal(resolved)
	if err != nil {
		return input, err
	}
	var requests AgentToolRequests
	if err = json.Unmarshal(raw, &requests); err != nil {
		return input, err
	}
	input.AgentRequests = &requests
	return input, nil
}
