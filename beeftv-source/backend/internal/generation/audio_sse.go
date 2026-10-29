package generation

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// readSpeechAudioEvents accepts OpenAI speech audio deltas and BeefAPI's
// signed-result URL extension. A heartbeat or EOF is never a completed song.
func readSpeechAudioEvents(ctx context.Context, data []byte) ([]byte, string, error) {
	var audio bytes.Buffer
	done := false
	resultURL := ""
	for _, frame := range sseFrameBoundaryPattern.Split(string(data), -1) {
		var lines []string
		for _, line := range strings.Split(strings.ReplaceAll(frame, "\r\n", "\n"), "\n") {
			if strings.HasPrefix(line, "data:") {
				lines = append(lines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
		}
		raw := strings.Join(lines, "\n")
		if raw == "" || raw == "[DONE]" {
			continue
		}
		var event struct {
			Type     string          `json:"type"`
			Audio    string          `json:"audio"`
			AudioURL string          `json:"audio_url"`
			Error    json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal([]byte(raw), &event); err != nil {
			return nil, "", fmt.Errorf("音频事件无法解析：%w", err)
		}
		if len(event.Error) > 0 && string(event.Error) != "null" {
			return nil, "", errors.New("音乐生成失败，请查看任务详情")
		}
		switch event.Type {
		case "speech.audio.delta":
			if done {
				return nil, "", errors.New("音频完成后收到额外内容")
			}
			chunk, err := base64.StdEncoding.DecodeString(event.Audio)
			if err != nil {
				return nil, "", errors.New("音频事件编码无效")
			}
			audio.Write(chunk)
		case "speech.audio.done":
			if done {
				return nil, "", errors.New("收到重复的音频完成事件")
			}
			done = true
			resultURL = event.AudioURL
		case "error":
			return nil, "", errors.New("音乐生成失败，请查看任务详情")
		}
	}
	if !done {
		return nil, "", errors.New("音乐生成连接中断，未收到完成结果；请先检查原任务，避免重复付费")
	}
	if resultURL != "" {
		if audio.Len() > 0 || !IsPublicMediaURL(resultURL) {
			return nil, "", errors.New("音乐生成结果地址无效")
		}
		return GetExternalBinary(WithRequestKind(ctx, "download"), resultURL)
	}
	if audio.Len() == 0 {
		return nil, "", errors.New("音乐生成结果为空")
	}
	return audio.Bytes(), "audio/mpeg", nil
}
