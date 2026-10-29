package editing

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
)

// Probe reads codec_type streams and container duration from a local media file.
func Probe(ctx context.Context, path string) (SourceFacts, error) {
	bin, err := exec.LookPath("ffprobe")
	if err != nil {
		return SourceFacts{}, fmt.Errorf("媒体探测依赖未安装（需要 ffprobe）")
	}
	cmd := exec.CommandContext(ctx, bin,
		"-v", "error", "-show_entries", "stream=codec_type:format=duration",
		"-of", "json", path)
	output, runErr := cmd.Output()
	if runErr != nil {
		return SourceFacts{}, fmt.Errorf("媒体音轨探测失败: %w", runErr)
	}
	var parsed struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(output, &parsed); err != nil {
		return SourceFacts{}, fmt.Errorf("无法解析素材：%w", err)
	}
	facts := SourceFacts{}
	for _, stream := range parsed.Streams {
		switch stream.CodecType {
		case "audio":
			facts.HasAudio = true
		case "video":
			facts.HasVideo = true
		}
	}
	if seconds, convErr := parseProbeSeconds(parsed.Format.Duration); convErr == nil {
		facts.DurationMs = int64(seconds * 1000)
	}
	return facts, nil
}

func parseProbeSeconds(raw string) (float64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.EqualFold(raw, "N/A") {
		return 0, fmt.Errorf("missing duration")
	}
	seconds, err := strconv.ParseFloat(raw, 64)
	if err != nil || seconds <= 0 || math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return 0, fmt.Errorf("invalid duration")
	}
	return seconds, nil
}

// SubtitleFontFailure reports libass exits that look successful while no font
// could render the subtitle glyphs. A successful fallback attempt is not failure.
func SubtitleFontFailure(output string) bool {
	text := strings.ToLower(output)
	for _, failure := range []string{
		"failed to find any fallback", "no usable fontconfig", "fontselect: failed",
		"can't find selected font provider", "couldn't find font family",
		"failed to find font", "no fonts found", "missing glyph",
	} {
		if strings.Contains(text, failure) {
			return true
		}
	}
	return false
}
