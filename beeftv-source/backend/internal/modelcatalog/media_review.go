package modelcatalog

import (
	"strings"

	"infinite-canvas/backend/internal/assistant"
)

const MediaReviewModel = "wand-vega-vl-1.0-flash"

// A review model uses the same channel and credentials as other selections,
// but its verified media adapter does not grant it the main assistant role.
func ResolveMediaReviewProvider(snapshot AssistantConfigSnapshot, lookup ManagedCredentialLookup) (assistant.Provider, string) {
	selection := strings.TrimSpace(snapshot.MediaReviewModel)
	channelID, modelID := SplitModelKey(selection)
	channel, found := FindAssistantChannel(snapshot.Channels, channelID, modelID)
	if selection == "" || !found {
		return assistant.Provider{}, AssistantReasonModelNotConfigured
	}
	resolved := assistantModelAlias(channel, modelID)
	if resolved != assistantModelAlias(channel, MediaReviewModel) {
		return assistant.Provider{}, AssistantReasonProtocolUnsupported
	}
	protocol, ok := ChannelModelProtocol(channel, resolved)
	if !ok || protocol != "chat-completion" {
		return assistant.Provider{}, AssistantReasonProtocolUnsupported
	}
	return resolveChannelModel(snapshot, selection, lookup, []string{MediaReviewModel})
}
