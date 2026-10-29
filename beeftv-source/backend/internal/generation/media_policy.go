package generation

import (
	"context"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/providerpreset"
)

func MediaHydrationPolicyFor(ctx context.Context, input Input) MediaHydrationPolicy {
	if input.Config.InterfaceType == "full-video" {
		return MediaHydrationPolicy{KeepLocal: true}
	}
	if requiresBeefAPIHTTPReferences(ctx, input.Config) {
		return MediaHydrationPolicy{KeepLocal: true}
	}
	policy := MediaHydrationPolicy{PreferURL: PrefersMediaURLs(input.Config.InterfaceType, input)}
	if model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(input.Config.InterfaceType)) {
		return MediaHydrationPolicy{PreferHTTPS: true}
	}
	if IsBeefAPIVideoConfig(ctx, input.Config) {
		if contract, ok := providerpreset.BeefAPIVideoContract(input.Config.Model); ok && contract.InlineMedia && (contract.Protocol == input.Config.InterfaceType || IsSeedanceVideoConfig(input.Config)) {
			return MediaHydrationPolicy{PreferHTTPS: true, KeepLocal: IsBeefAPISeedancePreuploadConfig(ctx, input.Config)}
		}
	}
	if strings.TrimSpace(input.Config.InterfaceType) == string(model.ChannelInterfaceNewAPIChannel1) {
		policy.RequireURL = false
		policy.PreferURL = false
		return policy
	}
	switch strings.TrimSpace(input.Config.InterfaceType) {
	case string(model.ChannelInterfaceNewAPIVideo), string(model.ChannelInterfaceNewAPIChannel1), string(model.ChannelInterfaceNewAPIChannel2), string(model.ChannelInterfaceVolcengineArkVideo), string(model.ChannelInterfaceVolcengineArkAgentPlanVideo), string(model.ChannelInterfaceMiniMaxVideo):
		policy.RequireURL = true
		policy.PreferURL = true
	}
	if adapter, ok := ProtocolAdapterForContext(ctx, input.Config.InterfaceType); ok {
		policy.RequireURL = adapter.Metadata().RequiresPublicMediaURLs
		policy.PreferURL = policy.PreferURL || policy.RequireURL
	}
	if input.Mode == "image" && input.Mask != nil {
		policy.RequireURL = false
		policy.PreferURL = false
	}
	return policy
}

// One protocol can accept inline images while requiring URLs for video/audio.
// Explicit custom-channel choices override that protocol's default only.
func mediaPolicyForKind(ctx context.Context, input Input, kind string, policy MediaHydrationPolicy) MediaHydrationPolicy {
	if policy.KeepLocal {
		return policy // Provider-owned upload flows must retain their local bytes.
	}
	if kind == "mask" {
		if input.Mode == "image" && strings.TrimSpace(input.Config.InterfaceType) == string(model.ChannelInterfaceOpenAIImage) {
			return MediaHydrationPolicy{} // OpenAI Images sends the mask as multipart bytes.
		}
		kind = "image"
	}
	transport := ""
	if adapter, ok := ProtocolAdapterForContext(ctx, input.Config.InterfaceType); ok {
		transport = adapter.Metadata().MediaTransport[kind]
	}
	if input.Config.ChannelID == "" {
		if override := input.Config.ReferenceMediaTransport[kind]; override != "" && override != "auto" {
			transport = override
		}
	}
	switch transport {
	case "inline":
		policy.RequireURL, policy.PreferURL, policy.PreferHTTPS = false, false, false
	case "url", "link":
		policy.RequireURL, policy.PreferURL, policy.PreferHTTPS = true, true, false
		policy.ManualURL = transport == "link"
	}
	if kind == "video" && isBytePlusVideoInput(input) {
		policy.RequireURL, policy.PreferURL, policy.PreferHTTPS = true, true, false
	}
	return policy
}

// PrefersMediaURLs lists protocols that accept remote URLs. Multipart/byte
// protocols keep the byte path so a smaller download cannot change the request.
func PrefersMediaURLs(interfaceType string, input Input) bool {
	if input.Mode == "image" && input.Mask != nil {
		return false
	}
	switch strings.TrimSpace(interfaceType) {
	case string(model.ChannelInterfaceChatCompletion), string(model.ChannelInterfaceOpenAIResponse), string(model.ChannelInterfaceClaudeAPI),
		string(model.ChannelInterfaceGrokImage), string(model.ChannelInterfaceVolcengineArkImage), string(model.ChannelInterfaceVolcengineArkAgentPlanImage),
		string(model.ChannelInterfaceXAIVideo), string(model.ChannelInterfaceNovitaVideo),
		string(model.ChannelInterfaceMiniMaxVideo), string(model.ChannelInterfaceNewAPIVideo),
		string(model.ChannelInterfaceNewAPIChannel1), string(model.ChannelInterfaceNewAPIChannel2),
		string(model.ChannelInterfaceVolcengineArkVideo), string(model.ChannelInterfaceVolcengineArkAgentPlanVideo):
		return true
	}
	if IsGrokVideoConfig(input.Config) || IsSeedanceVideoConfig(input.Config) || IsArkPlanVideoConfig(input.Config) {
		return true
	}
	return false
}
