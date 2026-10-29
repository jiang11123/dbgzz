package workflow

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"strings"
	"time"
)

const defaultPollTimeout = time.Hour
const legacyPollInterval = 2500 * time.Millisecond

// defaultVideoPollInterval matches internal/app.defaultVideoPollInterval.
// The provider worker owns videoPollPolicy; this is the mapping seam default.
const defaultVideoPollInterval = 30 * time.Second

func errf(format string, args ...any) error {
	return fmt.Errorf(format, args...)
}

func errText(message string) error {
	return errors.New(message)
}

func stringValue(value any) string {
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "<nil>" {
		return ""
	}
	return text
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func ptr[T any](value T) *T { return &value }

func isPublicMediaURL(value string) bool {
	lower := strings.ToLower(value)
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

func dataURL(mimeType string, data []byte) string {
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return "data:" + strings.Split(mimeType, ";")[0] + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func decodeDataURL(value string) (string, []byte, error) {
	header, encoded, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(header, "data:") || !strings.HasSuffix(strings.ToLower(header), ";base64") {
		return "", nil, errors.New("data URL 格式无效")
	}
	mimeType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
	data, err := base64.StdEncoding.DecodeString(encoded)
	return mimeType, data, err
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
	extensions, _ := mime.ExtensionsByType(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	extension := ".bin"
	if len(extensions) > 0 {
		extension = extensions[0]
	}
	return "reference-" + base + extension
}

// DefaultTimePolicy matches the previous service clock: context-aware sleep,
// 1 hour poll window when the context has no deadline, 2.5s legacy interval.
type DefaultTimePolicy struct{}

func (DefaultTimePolicy) Now() time.Time { return time.Now() }

func (DefaultTimePolicy) Sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (DefaultTimePolicy) PollDeadline(ctx context.Context) time.Time {
	if deadline, ok := ctx.Deadline(); ok {
		return deadline
	}
	return time.Now().Add(defaultPollTimeout)
}

func (DefaultTimePolicy) LegacyPollInterval() time.Duration { return legacyPollInterval }
