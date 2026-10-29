package generation

// 音频生成。

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/model"
)

func RunAudioTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	music := strings.Contains(strings.ToLower(input.Config.Model), "minimax-music-")
	if music {
		input.Config.AudioFormat = "mp3"
	}
	if _, ok := DeclarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType); ok {
		return RunDeclarativeProtocolTask(ctx, input)
	}
	if resolved, ok := input.Metadata["resolvedCharacterVersions"].([]interface{}); ok && len(resolved) > 0 {
		voiceKey := metadataString(input.Metadata, "resolvedCharacterVoiceKey")
		if voiceKey == "" || strings.TrimSpace(input.Config.AudioVoice) != voiceKey {
			return nil, errors.New("角色配音缺少已解析的声音绑定")
		}
	}
	format := defaultString(input.Config.AudioFormat, "mp3")
	body := map[string]interface{}{
		"model":           input.Config.Model,
		"input":           input.Prompt,
		"response_format": format,
		"speed":           1,
	}
	if voice := ResolvedAudioSpeechVoice(input.Config.Model, input.Config.AudioVoice); voice != "" {
		body["voice"] = voice
	}
	if input.Config.AudioSpeed != "" {
		body["speed"] = ParseFloat(input.Config.AudioSpeed, 1)
	}
	if input.Config.AudioInstructions != "" {
		body["instructions"] = input.Config.AudioInstructions
	}
	if music {
		body["metadata"] = map[string]interface{}{"audio_setting": map[string]interface{}{"sample_rate": 44100, "bitrate": 256000, "format": "mp3"}}
	}
	if input.Config.InterfaceType == string(model.ChannelInterfaceAsyncAudio) {
		return RunAsyncAudioTask(ctx, input, body, format)
	}
	if music && isBeefAPIHostFromURL(input.Config.BaseURL) {
		body["stream_format"] = "sse"
	}
	data, mimeType, err := PostBinary(ctx, input.Config, "/audio/speech", body)
	if err != nil {
		return nil, err
	}
	if strings.Contains(strings.ToLower(mimeType), "text/event-stream") {
		data, mimeType, err = readSpeechAudioEvents(ctx, data)
		if err != nil {
			return nil, err
		}
	}
	mimeType, err = ValidateGeneratedAudio(mimeType, data, format)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"mode": "audio", "audio": map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType, "format": format}}, nil
}

func isBeefAPIHostFromURL(raw string) bool {
	if beefapi.IsEnterpriseBaseURL(raw) {
		return true
	}
	// Use the existing explicit loopback enterprise override in desktop acceptance.
	// CanonicalOrigin rejects non-loopback custom origins.
	origin, err := beefapi.CanonicalOrigin("")
	return err == nil && strings.TrimSuffix(strings.TrimRight(raw, "/"), "/v1") == origin
}

func RunAsyncAudioTask(ctx context.Context, input Input, body map[string]interface{}, format string) (map[string]interface{}, error) {
	id := ResumedProviderRequestID(ctx)
	var state map[string]interface{}
	if id == "" {
		if err := PostJSON(ctx, input.Config, "/audio/tasks", body, &state); err != nil {
			return nil, err
		}
		state = AsyncAudioPayload(state)
		extracted, err := firstJSONString(state, "id", "task_id", "request_id")
		if err != nil {
			return nil, fmt.Errorf("异步音频接口任务 ID 无效：%w", err)
		}
		id = extracted
		if id == "" {
			return nil, errors.New("异步音频接口没有返回任务 ID")
		}
		if AsyncAudioSucceeded(state) {
			return AsyncAudioResult(ctx, input.Config, id, state, format)
		}
	}
	for deadline := PollingDeadline(ctx); time.Now().Before(deadline); {
		state = map[string]interface{}{}
		pollCtx := WithRequestKind(ctx, "poll")
		if err := GetJSON(pollCtx, input.Config, "/audio/tasks/"+url.PathEscape(id), &state); err != nil {
			return nil, err
		}
		state = AsyncAudioPayload(state)
		if AsyncAudioSucceeded(state) {
			return AsyncAudioResult(ctx, input.Config, id, state, format)
		}
		status := strings.ToLower(strings.TrimSpace(stringField(state, "status")))
		if status == "failed" || status == "cancelled" || status == "canceled" || status == "expired" || status == "error" {
			return nil, fmt.Errorf("异步音频生成失败（任务 %s）：%s", id, AsyncAudioErrorMessage(state))
		}
		if err := SleepContext(ctx, 2500*time.Millisecond); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("异步音频生成超时（任务 %s）", id)
}

func AsyncAudioPayload(payload map[string]interface{}) map[string]interface{} {
	for _, key := range []string{"data", "result", "output"} {
		if nested, ok := payload[key].(map[string]interface{}); ok {
			for parentKey, parentValue := range payload {
				if parentKey == "data" || parentKey == "result" || parentKey == "output" {
					continue
				}
				if _, exists := nested[parentKey]; !exists {
					nested[parentKey] = parentValue
				}
			}
			return nested
		}
	}
	return payload
}

func AsyncAudioSucceeded(state map[string]interface{}) bool {
	status := strings.ToLower(strings.TrimSpace(stringField(state, "status")))
	done, _ := state["done"].(bool)
	return done || status == "completed" || status == "succeeded" || status == "success" || status == "done" || (status == "" && AsyncAudioResultURL(state) != "")
}

func AsyncAudioResult(ctx context.Context, config Config, id string, state map[string]interface{}, format string) (map[string]interface{}, error) {
	resultURL := AsyncAudioResultURL(state)
	var data []byte
	var mimeType string
	var err error
	if strings.HasPrefix(resultURL, "data:") {
		mimeType, data, err = DecodeProviderDataURL(resultURL)
		if err == nil {
			limit, limitErr := GeneratedFileLimit(ctx)
			if limitErr != nil {
				err = limitErr
			} else if int64(len(data)) > limit {
				err = fmt.Errorf("异步音频结果超过 %s 限制", formatStorageLimit(limit))
			}
		}
	} else if IsPublicMediaURL(resultURL) {
		data, mimeType, err = GetExternalBinary(WithRequestKind(ctx, "download"), resultURL)
	} else {
		data, mimeType, err = GetBinary(WithRequestKind(ctx, "download"), config, "/audio/tasks/"+url.PathEscape(id)+"/content")
	}
	if err != nil {
		return nil, fmt.Errorf("异步音频结果下载失败（任务 %s）：%w", id, err)
	}
	mimeType, err = ValidateGeneratedAudio(mimeType, data, format)
	if err != nil {
		return nil, fmt.Errorf("异步音频结果无效（任务 %s）：%w", id, err)
	}
	return map[string]interface{}{"mode": "audio", "audio": map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType, "format": format}}, nil
}

func AsyncAudioResultURL(state map[string]interface{}) string {
	for _, key := range []string{"audio_url", "audioUrl", "result_url", "resultUrl", "output_url", "outputUrl", "url", "data"} {
		if value := strings.TrimSpace(stringField(state, key)); strings.HasPrefix(value, "data:") || IsPublicMediaURL(value) {
			return value
		}
	}
	for _, key := range []string{"audio", "data", "result", "output"} {
		if nested, ok := state[key].(map[string]interface{}); ok {
			if value := AsyncAudioResultURL(nested); value != "" {
				return value
			}
		}
	}
	return ""
}

func AsyncAudioErrorMessage(state map[string]interface{}) string {
	_, message := FailureDetails(state)
	return defaultString(message, firstNonEmpty(stringField(state, "message"), "上游返回失败状态"))
}

func DecodeProviderDataURL(value string) (string, []byte, error) {
	header, encoded, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(header, "data:") || !strings.HasSuffix(strings.ToLower(header), ";base64") {
		return "", nil, errors.New("data URL 格式无效")
	}
	mimeType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
	data, err := base64.StdEncoding.DecodeString(encoded)
	return mimeType, data, err
}

func ValidateGeneratedAudio(declared string, data []byte, format string) (string, error) {
	if len(data) == 0 {
		return "", errors.New("音频内容为空")
	}
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	if strings.Contains(detected, "json") || strings.HasPrefix(detected, "text/") || strings.HasPrefix(detected, "image/") || strings.HasPrefix(detected, "video/") {
		return "", fmt.Errorf("上游返回了非音频内容：%s", detected)
	}
	mimeType := strings.ToLower(strings.TrimSpace(strings.Split(declared, ";")[0]))
	resolved := ""
	if strings.HasPrefix(mimeType, "audio/") {
		resolved = mimeType
	} else if strings.HasPrefix(detected, "audio/") {
		resolved = detected
	} else if fallback := AudioFormatMimeType(format); fallback != "" && (mimeType == "" || mimeType == "application/octet-stream") {
		resolved = fallback
	}
	if resolved == "" {
		return "", fmt.Errorf("上游响应类型不是音频：%s", defaultString(mimeType, detected))
	}
	if !AudioSignatureMatches(resolved, data) {
		return "", fmt.Errorf("音频内容与格式不匹配：%s", resolved)
	}
	return resolved, nil
}

func AudioSignatureMatches(mimeType string, data []byte) bool {
	if strings.Contains(mimeType, "pcm") || mimeType == "audio/l16" {
		return len(data) > 0
	}
	if strings.Contains(mimeType, "mpeg") || strings.Contains(mimeType, "mp3") {
		return bytes.HasPrefix(data, []byte("ID3")) || (len(data) >= 2 && data[0] == 0xff && data[1]&0xe0 == 0xe0)
	}
	if strings.Contains(mimeType, "wav") || strings.Contains(mimeType, "wave") {
		return len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WAVE"))
	}
	if strings.Contains(mimeType, "opus") || strings.Contains(mimeType, "ogg") {
		return bytes.HasPrefix(data, []byte("OggS"))
	}
	if strings.Contains(mimeType, "flac") {
		return bytes.HasPrefix(data, []byte("fLaC"))
	}
	if strings.Contains(mimeType, "aac") {
		return bytes.HasPrefix(data, []byte("ADIF")) || (len(data) >= 2 && data[0] == 0xff && data[1]&0xf0 == 0xf0)
	}
	return false
}

func ResolvedAudioSpeechVoice(model, voice string) string {
	id := strings.ToLower(strings.TrimSpace(model))
	if index := strings.LastIndex(id, "::"); index >= 0 {
		id = id[index+2:]
	}
	trimmed := strings.TrimSpace(voice)
	if strings.Contains(id, "minimax-music") {
		return ""
	}
	if strings.Contains(id, "minimax-speech") {
		if trimmed == "" || IsOpenAISpeechVoice(trimmed) || trimmed == "中文" {
			return "male-qn-qingse"
		}
		return trimmed
	}
	if trimmed == "" {
		return "alloy"
	}
	return trimmed
}

func IsOpenAISpeechVoice(voice string) bool {
	switch strings.ToLower(strings.TrimSpace(voice)) {
	case "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar":
		return true
	default:
		return false
	}
}

func AudioFormatMimeType(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "wav":
		return "audio/wav"
	case "opus":
		return "audio/opus"
	case "aac":
		return "audio/aac"
	case "flac":
		return "audio/flac"
	case "pcm":
		return "audio/pcm"
	case "mp3":
		return "audio/mpeg"
	default:
		return ""
	}
}
