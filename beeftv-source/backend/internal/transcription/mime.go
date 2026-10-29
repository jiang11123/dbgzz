package transcription

import "strings"

func IsTranscribableMIME(mime string) bool {
	return strings.HasPrefix(mime, "video/") || strings.HasPrefix(mime, "audio/")
}

func ExtForMIME(mime string) string {
	switch {
	case strings.HasPrefix(mime, "video/mp4"), strings.HasPrefix(mime, "audio/mp4"):
		return ".mp4"
	case strings.HasPrefix(mime, "video/webm"), strings.HasPrefix(mime, "audio/webm"):
		return ".webm"
	case strings.HasPrefix(mime, "video/quicktime"):
		return ".mov"
	case strings.HasPrefix(mime, "audio/mpeg"), strings.HasPrefix(mime, "audio/mp3"):
		return ".mp3"
	case strings.HasPrefix(mime, "audio/wav"), strings.HasPrefix(mime, "audio/x-wav"), strings.HasPrefix(mime, "audio/wave"):
		return ".wav"
	case strings.HasPrefix(mime, "audio/flac"):
		return ".flac"
	case strings.HasPrefix(mime, "audio/aac"):
		return ".aac"
	case strings.HasPrefix(mime, "audio/ogg"), strings.HasPrefix(mime, "video/ogg"):
		return ".ogg"
	default:
		return ".bin"
	}
}
