package asset

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
)

func NormalizedUploadKey(values []string) *string {
	if len(values) == 0 || strings.TrimSpace(values[0]) == "" {
		return nil
	}
	digest := sha256.Sum256([]byte(strings.TrimSpace(values[0])))
	value := hex.EncodeToString(digest[:])
	return &value
}

// EnsureUploadIdentity keeps a stable client key for idempotent replay and
// mints a unique operation identity when the caller did not supply one.
func EnsureUploadIdentity(values []string) []string {
	if len(values) == 0 || strings.TrimSpace(values[0]) == "" {
		return []string{kernel.NewID()}
	}
	return values
}

func DetectUploadedMimeType(file io.ReadSeeker, fileName string, declared string) string {
	declared = strings.TrimSpace(strings.Split(declared, ";")[0])
	if declared != "" && declared != "application/octet-stream" {
		return declared
	}
	if file == nil {
		if fromExtension := mime.TypeByExtension(filepath.Ext(fileName)); fromExtension != "" {
			return strings.TrimSpace(strings.Split(fromExtension, ";")[0])
		}
		return "application/octet-stream"
	}
	buffer := make([]byte, 512)
	read, _ := file.Read(buffer)
	_, _ = file.Seek(0, io.SeekStart)
	if detected := http.DetectContentType(buffer[:read]); detected != "" && detected != "application/octet-stream" {
		return strings.TrimSpace(strings.Split(detected, ";")[0])
	}
	if fromExtension := mime.TypeByExtension(filepath.Ext(fileName)); fromExtension != "" {
		return strings.TrimSpace(strings.Split(fromExtension, ";")[0])
	}
	return "application/octet-stream"
}

func ExtensionFromMimeType(mimeType string) string {
	if strings.Contains(mimeType, "png") {
		return "png"
	}
	if strings.Contains(mimeType, "jpeg") {
		return "jpg"
	}
	if strings.Contains(mimeType, "webp") {
		return "webp"
	}
	if strings.Contains(mimeType, "gif") {
		return "gif"
	}
	if strings.Contains(mimeType, "mp4") {
		return "mp4"
	}
	if strings.Contains(mimeType, "webm") {
		return "webm"
	}
	if strings.Contains(mimeType, "mpeg") {
		return "mp3"
	}
	if strings.Contains(mimeType, "wav") {
		return "wav"
	}
	return "bin"
}

func FileExtension(fileName string, mimeType string, kind string) string {
	if ext := strings.ToLower(filepath.Ext(strings.TrimSpace(fileName))); ext != "" && ext != "." {
		return ext
	}
	cleanMimeType := strings.TrimSpace(strings.Split(mimeType, ";")[0])
	if extensions, err := mime.ExtensionsByType(cleanMimeType); err == nil && len(extensions) > 0 {
		return strings.ToLower(extensions[0])
	}
	if mapped := ExtensionFromMimeType(cleanMimeType); mapped != "bin" {
		return "." + mapped
	}
	switch kind {
	case "image":
		return ".png"
	case "video":
		return ".mp4"
	case "audio":
		return ".mp3"
	default:
		return ".bin"
	}
}

func NormalizeKind(kind string, mimeType string) string {
	kind = strings.ToLower(strings.TrimSpace(kind))
	switch kind {
	case "image", "video", "audio", "file":
		return kind
	}
	if strings.HasPrefix(mimeType, "image/") {
		return "image"
	}
	if strings.HasPrefix(mimeType, "video/") {
		return "video"
	}
	if strings.HasPrefix(mimeType, "audio/") {
		return "audio"
	}
	return "file"
}

func ObjectKey(userID string, kind string, fileName string, mimeType string, now time.Time) string {
	ext := FileExtension(fileName, mimeType, kind)
	return path.Join("users", safeObjectSegment(userID), kind, now.Format("2006/01/02"), kernel.NewID()+ext)
}

func safeObjectSegment(value string) string {
	value = strings.TrimSpace(value)
	value = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, value)
	return strings.Trim(value, "-")
}

func NormalizeSingleByteRange(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 128 || !strings.HasPrefix(value, "bytes=") || strings.Contains(value, ",") {
		return ""
	}
	start, end, ok := strings.Cut(strings.TrimPrefix(value, "bytes="), "-")
	if !ok || (start == "" && end == "") || !decimalDigits(start) || !decimalDigits(end) {
		return ""
	}
	return "bytes=" + start + "-" + end
}

func decimalDigits(value string) bool {
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func parseNormalizedByteRange(normalized string, size int64) (start int64, end int64, ok bool) {
	spec := strings.TrimPrefix(normalized, "bytes=")
	startText, endText, found := strings.Cut(spec, "-")
	if !found {
		return 0, 0, false
	}
	if startText == "" {
		suffix, err := strconv.ParseInt(endText, 10, 64)
		if err != nil || suffix <= 0 || size <= 0 {
			return 0, 0, false
		}
		if suffix > size {
			return 0, size - 1, true
		}
		return size - suffix, size - 1, true
	}
	start, err := strconv.ParseInt(startText, 10, 64)
	if err != nil || start < 0 {
		return 0, 0, false
	}
	if endText == "" {
		if size <= 0 || start >= size {
			return 0, 0, false
		}
		return start, size - 1, true
	}
	end, err = strconv.ParseInt(endText, 10, 64)
	if err != nil || start > end {
		return 0, 0, false
	}
	if size <= 0 || start >= size {
		return 0, 0, false
	}
	if end >= size {
		end = size - 1
	}
	return start, end, true
}
