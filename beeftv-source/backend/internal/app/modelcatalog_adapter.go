package app

import (
	"infinite-canvas/backend/internal/modelcatalog"
)

func taskMediaFromProvider(media providerMedia) modelcatalog.MediaRef {
	return modelcatalog.MediaRef{
		URL:        media.URL,
		StorageKey: media.StorageKey,
		Bytes:      media.Bytes,
		Width:      media.Width,
		Height:     media.Height,
		DurationMs: media.DurationMs,
	}
}

func taskMediaListFromProvider(items []providerMedia) []modelcatalog.MediaRef {
	if items == nil {
		return nil
	}
	result := make([]modelcatalog.MediaRef, len(items))
	for i, item := range items {
		result[i] = taskMediaFromProvider(item)
	}
	return result
}

func taskInputFromCanvas(input canvasGenerationInput) modelcatalog.TaskInput {
	task := modelcatalog.TaskInput{
		Mode:            input.Mode,
		Prompt:          input.Prompt,
		ReferenceImages: taskMediaListFromProvider(input.ReferenceImages),
		ReferenceVideos: taskMediaListFromProvider(input.ReferenceVideos),
		ReferenceAudios: taskMediaListFromProvider(input.ReferenceAudios),
		Metadata:        input.Metadata,
		Config: modelcatalog.TaskConfig{
			ChannelID:           input.Config.ChannelID,
			ChannelModelKey:     input.Config.ChannelModelKey,
			Model:               input.Config.Model,
			InterfaceType:       input.Config.InterfaceType,
			APIFormat:           input.Config.APIFormat,
			BaseURL:             input.Config.BaseURL,
			Size:                input.Config.Size,
			Quality:             input.Config.Quality,
			Count:               input.Config.Count,
			VideoSeconds:        input.Config.VideoSeconds,
			VQuality:            input.Config.VQuality,
			CapabilityConfig:    input.Config.CapabilityConfig,
			SystemPrompt:        input.Config.SystemPrompt,
			ComposedPromptBytes: len(withSystemPrompt(input.Config, input.Prompt)),
		},
	}
	if input.Mask != nil {
		media := taskMediaFromProvider(*input.Mask)
		task.Mask = &media
	}
	return task
}

func applyTaskConfigToCanvas(input *canvasGenerationInput, task modelcatalog.TaskInput) {
	if input == nil {
		return
	}
	input.Config.VQuality = task.Config.VQuality
}
