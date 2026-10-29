package editing

import (
	"fmt"
	"strings"
)

// FormatSRTTimestamp 将毫秒时间格式化为 SRT 时间戳 hh:mm:ss,mmm。
func FormatSRTTimestamp(ms int64) string {
	if ms < 0 {
		ms = 0
	}
	hours := ms / 3600000
	minutes := (ms % 3600000) / 60000
	seconds := (ms % 60000) / 1000
	millis := ms % 1000
	return fmt.Sprintf("%02d:%02d:%02d,%03d", hours, minutes, seconds, millis)
}

func buildSubtitleSRT(subtitles []Subtitle) string {
	if len(subtitles) == 0 {
		return ""
	}
	var out strings.Builder
	for i, clip := range subtitles {
		fmt.Fprintf(&out, "%d\n%s --> %s\n%s\n\n",
			i+1,
			FormatSRTTimestamp(clip.StartMs),
			FormatSRTTimestamp(clip.StartMs+clip.DurationMs),
			clip.Text)
	}
	return out.String()
}
