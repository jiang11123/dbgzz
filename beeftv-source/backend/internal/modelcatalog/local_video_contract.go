package modelcatalog

import (
	"slices"

	"infinite-canvas/backend/internal/providerpreset"
)

// ApplyLocalVideoContract matches the desktop configuration's BeefAPI overlay.
// A versioned gateway profile owns its limits. Otherwise, verified route limits
// repair legacy generic profiles without changing the saved audio default.
func ApplyLocalVideoContract(item LocalChannelModel, config *ModelCapabilityConfig) *ModelCapabilityConfig {
	if item.Capability != "video" || item.VideoCapabilitiesVersion != nil || !providerpreset.IsBeefAPIEndpoint(item.BaseURL) || config == nil || config.Video == nil {
		return config
	}
	contract, ok := providerpreset.BeefAPIVideoContract(item.Model)
	if !ok {
		return config
	}
	result := *config
	video := *config.Video
	result.Video = &video
	if len(contract.Resolutions) > 0 {
		video.Resolutions = slices.Clone(contract.Resolutions)
		if !slices.Contains(video.Resolutions, video.DefaultResolution) {
			video.DefaultResolution = video.Resolutions[0]
		}
	}
	if len(contract.Ratios) > 0 {
		video.Ratios = slices.Clone(contract.Ratios)
		if !slices.Contains(video.Ratios, video.DefaultRatio) {
			video.DefaultRatio = video.Ratios[0]
		}
	}
	if contract.Duration != nil {
		video.Duration.Selection = "range"
		video.Duration.Min, video.Duration.Max, video.Duration.Default = contract.Duration.Min, contract.Duration.Max, contract.Duration.Default
	}
	if contract.GenerateAudio {
		video.GenerateAudio.Supported = true
	}
	for kind, limit := range contract.MaxReferences {
		switch kind {
		case "image":
			video.References.MaxImages = min(video.References.MaxImages, limit)
		case "video":
			video.References.MaxVideos = min(video.References.MaxVideos, limit)
		case "audio":
			video.References.MaxAudios = min(video.References.MaxAudios, limit)
		}
	}
	if len(contract.Operations) > 0 {
		video.Operations = slices.Clone(contract.Operations)
		if !slices.Contains(video.Operations, video.DefaultOperation) {
			video.DefaultOperation = video.Operations[0]
		}
	}
	return &result
}
