package generation

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"net/textproto"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/platform"
)

func stringField(payload map[string]interface{}, key string) string {
	value, err := platform.OptionalJSONString(payload, key)
	if err != nil {
		return ""
	}
	return value
}

func firstJSONString(payload map[string]any, keys ...string) (string, error) {
	return platform.FirstJSONString(payload, keys...)
}

func metadataString(metadata map[string]interface{}, key string) string {
	return strings.TrimSpace(stringField(metadata, key))
}

func metadataStringValues(value any) map[string]string {
	values := map[string]string{}
	raw, ok := value.(map[string]interface{})
	if !ok {
		return values
	}
	for key, item := range raw {
		values[key] = strings.TrimSpace(fmt.Sprint(item))
	}
	return values
}

func writeField(writer *multipart.Writer, key string, value string) {
	_ = writer.WriteField(key, value)
}

func writeMediaPart(writer *multipart.Writer, field string, media Media) error {
	raw, mimeType, err := MediaBytes(media)
	if err != nil {
		return err
	}
	filename := mediaFilename(media, mimeType)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": field, "filename": filename}))
	header.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	_, err = part.Write(raw)
	return err
}

func mediaFilename(media Media, mimeType string) string {
	base := strings.TrimSpace(media.ID)
	if base == "" {
		base = "reference"
	}
	var builder strings.Builder
	for _, char := range base {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' {
			builder.WriteRune(char)
			if builder.Len() >= 64 {
				break
			}
		}
	}
	base = builder.String()
	if base == "" {
		base = "reference"
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	// The system MIME database may list .m2a before .mp3. Audio endpoints
	// commonly validate the filename extension even when audio/mpeg is correct.
	if mediaType == "audio/mpeg" {
		return "reference-" + base + ".mp3"
	}
	extensions, _ := mime.ExtensionsByType(mediaType)
	extension := ".bin"
	if len(extensions) > 0 {
		extension = extensions[0]
	}
	return "reference-" + base + extension
}

func taskMediaFromProvider(media Media) modelcatalog.MediaRef {
	return modelcatalog.MediaRef{
		URL:        media.URL,
		StorageKey: media.StorageKey,
		Bytes:      media.Bytes,
		Width:      media.Width,
		Height:     media.Height,
		DurationMs: media.DurationMs,
	}
}

func taskMediaListFromProvider(items []Media) []modelcatalog.MediaRef {
	if items == nil {
		return nil
	}
	result := make([]modelcatalog.MediaRef, len(items))
	for i, item := range items {
		result[i] = taskMediaFromProvider(item)
	}
	return result
}

func taskInputFromCanvas(input Input) modelcatalog.TaskInput {
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
			ComposedPromptBytes: len(WithSystemPrompt(input.Config, input.Prompt)),
		},
	}
	if input.Mask != nil {
		media := taskMediaFromProvider(*input.Mask)
		task.Mask = &media
	}
	return task
}

func applyTaskConfigToCanvas(input *Input, task modelcatalog.TaskInput) {
	if input == nil {
		return
	}
	input.Config.VQuality = task.Config.VQuality
}

func applyFixedVideoResolution(input *Input, profile *VideoCapabilityConfig) {
	if input == nil {
		return
	}
	task := taskInputFromCanvas(*input)
	modelcatalog.ApplyFixedVideoResolution(&task, profile)
	applyTaskConfigToCanvas(input, task)
}

func validateVideoTask(profile *VideoCapabilityConfig, input Input) error {
	return modelcatalog.ValidateVideoTask(profile, taskInputFromCanvas(input))
}

func validateVideoTaskParameters(profile *VideoCapabilityConfig, input Input) error {
	return modelcatalog.ValidateVideoTaskParameters(profile, taskInputFromCanvas(input))
}

func validateImageTask(profile *ImageCapabilityConfig, input Input) error {
	return modelcatalog.ValidateImageTask(profile, taskInputFromCanvas(input))
}

func validateVideoReferenceImage(refs VideoReferenceConfig, index int, media Media) error {
	return modelcatalog.ValidateVideoReferenceImage(refs, index, taskMediaFromProvider(media))
}

func validateVideoReferenceVideo(refs VideoReferenceConfig, index int, media Media) error {
	return modelcatalog.ValidateVideoReferenceVideo(refs, index, taskMediaFromProvider(media))
}

func applySeedanceDocumentedVideoPixelFloor(config Config, refs *VideoReferenceConfig) {
	modelcatalog.ApplySeedanceDocumentedVideoPixelFloor(modelcatalog.TaskConfig{
		InterfaceType: config.InterfaceType,
		Model:         config.Model,
		BaseURL:       config.BaseURL,
	}, refs)
}

func videoResolutionNameRequest(profile *VideoCapabilityConfig, value string) string {
	return modelcatalog.VideoResolutionNameRequest(profile, value)
}

func isAutomaticVideoResolution(value string) bool {
	return modelcatalog.IsAutomaticVideoResolution(value)
}

func videoCapabilityAllowsAudioOnly(profile *VideoCapabilityConfig) bool {
	return modelcatalog.VideoCapabilityAllowsAudioOnly(profile)
}

func BadAuthRequest(message string) error {
	return kernel.BadAuthRequest(message)
}

func applySeedance2VideoProbe(ctx context.Context, config Config, index int, media *Media, data []byte) error {
	runtime, ok := RuntimeFromContext(ctx)
	if !ok || runtime.Probe == nil {
		return errors.New("参考视频无法校验，请重新导入")
	}
	return runtime.Probe.ProbeSeedance2Video(config, index, media, data)
}

func ensureChatCompletionStreamUsage(payload map[string]any) error {
	options := map[string]any{}
	if value, exists := payload["stream_options"]; exists {
		var ok bool
		options, ok = value.(map[string]any)
		if !ok {
			return errors.New("stream_options 必须是 JSON 对象")
		}
	}
	options["include_usage"] = true
	payload["stream_options"] = options
	return nil
}
