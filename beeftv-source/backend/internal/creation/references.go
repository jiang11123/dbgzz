package creation

import (
	"encoding/json"

	"infinite-canvas/backend/internal/protocol"
)

func validatePreparedProtocol(taskInputJSON string) error {
	var probe struct {
		ReferenceImages []struct {
			StorageKey string `json:"storageKey"`
			DataURL    string `json:"dataUrl"`
			URL        string `json:"url"`
		} `json:"referenceImages"`
		AgentRequests json.RawMessage `json:"agentRequests"`
	}
	if err := json.Unmarshal([]byte(taskInputJSON), &probe); err != nil {
		return err
	}
	if len(probe.AgentRequests) == 0 || string(probe.AgentRequests) == "null" {
		return nil
	}
	refs := make([]protocol.MediaRef, 0, len(probe.ReferenceImages))
	for _, media := range probe.ReferenceImages {
		refs = append(refs, protocol.MediaRef{StorageKey: media.StorageKey, DataURL: media.DataURL, URL: media.URL})
	}
	var requests any
	if err := json.Unmarshal(probe.AgentRequests, &requests); err != nil {
		return err
	}
	return protocol.ValidateProtocolPlaceholders(refs, requests)
}

func preparedImageCount(taskInputJSON string) int {
	var probe struct {
		ReferenceImages []json.RawMessage `json:"referenceImages"`
	}
	if err := json.Unmarshal([]byte(taskInputJSON), &probe); err != nil {
		return 0
	}
	return len(probe.ReferenceImages)
}
