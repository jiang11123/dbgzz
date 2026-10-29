package taskdelivery

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
)

var (
	ErrInvalidGeneratedDataURL = errors.New("生成内容 data URL 无效")
	ErrIngestStoreMissing      = errors.New("generated media store is not initialized")
)

const imageHeaderDecodeLimit = 2 << 20

// IngestOptions selects the current strict generated path or legacy migration.
// IdentityPrefix, when set, is the stable owner key RecoverOwned can resume;
// the empty prefix mints a new generated identity (concurrent inlines stay isolated).
type IngestOptions struct {
	SkipInvalidDataURL bool
	EnforceQuota       bool
	IdentityPrefix     string
}

// InlineArtifact is one decoded generated payload. Body is the original bytes;
// callers must not rebuild it by submitting a new provider generation.
type InlineArtifact struct {
	Kind         string
	FileName     string
	MimeType     string
	Size         int64
	Width        int
	Height       int
	DurationMs   int64
	Body         io.Reader
	Identity     string
	EnforceQuota bool
}

// InlineStore writes one generated inline artifact. It must not create a new
// upstream generation or mark a task bound/completed.
type InlineStore interface {
	PersistInline(userID string, artifact InlineArtifact) (*model.Resource, error)
}

// IngestDeps is the typed composition seam for first-stage ingest.
type IngestDeps struct {
	Store      InlineStore
	MaxBytes   func() (int64, error)
	ProbeVideo func([]byte) (int, int, int64)
}

// Ingestor owns first-stage generated dataURL/byte ingestion and ResultJSON
// rewriting. Deliverer owns later asset materialization. Ingest runs before
// durable task completion and never retries a paid provider call.
type Ingestor struct {
	store      InlineStore
	maxBytes   func() (int64, error)
	probeVideo func([]byte) (int, int, int64)
}

func NewIngestor(deps IngestDeps) *Ingestor {
	return &Ingestor{store: deps.Store, maxBytes: deps.MaxBytes, probeVideo: deps.ProbeVideo}
}

func (i *Ingestor) IngestResult(userID string, result map[string]interface{}, opts IngestOptions) (map[string]interface{}, error) {
	if result == nil {
		return map[string]interface{}{}, nil
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	var normalized map[string]interface{}
	if err := json.Unmarshal(encoded, &normalized); err != nil {
		return nil, err
	}
	value, err := i.Ingest(userID, normalized, opts)
	if err != nil {
		return nil, err
	}
	stored, _ := value.(map[string]interface{})
	if stored == nil {
		return map[string]interface{}{}, nil
	}
	return stored, nil
}

func (i *Ingestor) Ingest(userID string, value interface{}, opts IngestOptions) (interface{}, error) {
	if i == nil {
		return nil, ErrIngestStoreMissing
	}
	return i.ingestValue(userID, value, "", opts)
}

func (i *Ingestor) ingestValue(userID string, value interface{}, path string, opts IngestOptions) (interface{}, error) {
	switch item := value.(type) {
	case []interface{}:
		for index, child := range item {
			stored, err := i.ingestValue(userID, child, joinIngestPath(path, strconv.Itoa(index)), opts)
			if err != nil {
				return nil, err
			}
			item[index] = stored
		}
		return item, nil
	case map[string]interface{}:
		if raw := inlineMediaValue(item); raw != "" {
			if err := i.ingestInline(userID, item, raw, path, opts); err != nil {
				return nil, err
			}
		}
		for key, child := range item {
			stored, err := i.ingestValue(userID, child, joinIngestPath(path, key), opts)
			if err != nil {
				return nil, err
			}
			item[key] = stored
		}
		return item, nil
	default:
		return value, nil
	}
}

func (i *Ingestor) ingestInline(userID string, item map[string]interface{}, raw, path string, opts IngestOptions) error {
	mimeType, data, err := DecodeInlineDataURL(raw)
	if err == nil {
		err = i.checkMaxBytes(data)
	}
	if err != nil {
		if opts.SkipInvalidDataURL {
			return nil
		}
		return err
	}
	kind := asset.NormalizeKind("", mimeType)
	width, height := intValue(item["width"]), intValue(item["height"])
	durationMs := int64(intValue(item["durationMs"]))
	if kind == "image" && (width <= 0 || height <= 0) {
		width, height = imageDimensions(data)
	}
	if kind == "video" {
		probedWidth, probedHeight, probedDurationMs := i.probeGeneratedVideo(data)
		if width <= 0 {
			width = probedWidth
		}
		if height <= 0 {
			height = probedHeight
		}
		if durationMs <= 0 {
			durationMs = probedDurationMs
		}
	}
	if i.store == nil {
		return ErrIngestStoreMissing
	}
	resource, err := i.store.PersistInline(userID, InlineArtifact{
		Kind:         kind,
		FileName:     "generated." + asset.ExtensionFromMimeType(mimeType),
		MimeType:     mimeType,
		Size:         int64(len(data)),
		Width:        width,
		Height:       height,
		DurationMs:   durationMs,
		Body:         bytes.NewReader(data),
		Identity:     inlineIdentity(opts, path),
		EnforceQuota: opts.EnforceQuota,
	})
	if err != nil {
		return fmt.Errorf("生成内容写入资源存储失败：%w", err)
	}
	if resource == nil || strings.TrimSpace(resource.ID) == "" {
		return fmt.Errorf("生成内容写入资源存储失败：%w", ErrResourceMissing)
	}
	rewriteInlineResource(item, raw, *resource, kind)
	return nil
}

func (i *Ingestor) checkMaxBytes(data []byte) error {
	if i == nil || i.maxBytes == nil {
		return nil
	}
	limit, err := i.maxBytes()
	if err != nil {
		return err
	}
	if limit > 0 && int64(len(data)) > limit {
		return fmt.Errorf("单个生成资源超过 %dMB", limit>>20)
	}
	return nil
}

func (i *Ingestor) probeGeneratedVideo(data []byte) (int, int, int64) {
	if i == nil || i.probeVideo == nil {
		return 0, 0, 0
	}
	return i.probeVideo(data)
}

func inlineIdentity(opts IngestOptions, path string) string {
	prefix := strings.TrimSpace(opts.IdentityPrefix)
	if !opts.EnforceQuota || prefix == "" {
		return ""
	}
	if path == "" {
		return prefix + ":root"
	}
	return prefix + ":" + path
}

func joinIngestPath(parent, child string) string {
	// Escape JSON pointer segments so a key containing '/' cannot alias a
	// nested field. Leading/trailing whitespace is part of the JSON key.
	child = strings.ReplaceAll(strings.ReplaceAll(child, "~", "~0"), "/", "~1")
	return parent + "/" + child
}

func DecodeInlineDataURL(value string) (string, []byte, error) {
	header, encoded, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(header, "data:") || !strings.HasSuffix(strings.ToLower(header), ";base64") {
		return "", nil, fmt.Errorf("%w：格式无效", ErrInvalidGeneratedDataURL)
	}
	mimeType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", nil, fmt.Errorf("%w：base64 解码失败：%v", ErrInvalidGeneratedDataURL, err)
	}
	return mimeType, data, nil
}

func inlineMediaValue(item map[string]interface{}) string {
	for _, key := range []string{"dataUrl", "content", "url", "coverUrl"} {
		if text, ok := item[key].(string); ok && (strings.HasPrefix(text, "data:image/") || strings.HasPrefix(text, "data:video/") || strings.HasPrefix(text, "data:audio/")) {
			return text
		}
	}
	return ""
}

func rewriteInlineResource(item map[string]interface{}, raw string, resource model.Resource, kind string) {
	resourceURL := assets.FileURL(resource.ID)
	for _, key := range []string{"dataUrl", "content", "url", "coverUrl"} {
		if text, ok := item[key].(string); ok && (text == raw || strings.HasPrefix(text, "blob:")) {
			item[key] = resourceURL
		}
	}
	if _, ok := item["dataUrl"]; ok {
		item["dataUrl"] = resourceURL
	}
	item["url"] = resourceURL
	item["storageKey"] = "resource:" + resource.ID
	item["resourceId"] = resource.ID
	item["bytes"] = resource.Size
	item["mimeType"] = resource.MimeType
	item["width"] = resource.Width
	item["height"] = resource.Height
	if kind == "video" || resource.DurationMs > 0 {
		item["durationMs"] = resource.DurationMs
	}
}

func imageDimensions(data []byte) (int, int) {
	config, _, err := image.DecodeConfig(io.LimitReader(bytes.NewReader(data), imageHeaderDecodeLimit))
	if err != nil {
		return 0, 0
	}
	return config.Width, config.Height
}

func intValue(value interface{}) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return int(number)
	case int64:
		return int(number)
	default:
		return 0
	}
}
