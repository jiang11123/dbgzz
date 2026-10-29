package canvas

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"sort"
	"strings"
	"time"
)

// ArchiveMedia only carries the owned bytes and portable metadata used by the
// existing infinite-canvas v4 import format. No path or remote URL is accepted.
type ArchiveMedia struct {
	Body     io.ReadCloser
	MimeType string
	Bytes    int64
}

type ArchiveSource interface {
	OpenArchiveMedia(context.Context, string) (ArchiveMedia, error)
}

// WriteProjectArchive emits the same portable format as the canvas UI. Missing
// browser-only files fail the whole export instead of producing a partial ZIP.
func WriteProjectArchive(ctx context.Context, out io.Writer, raw json.RawMessage, source ArchiveSource) error {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return err
	}
	id, _ := doc["id"].(string)
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("画布缺少身份")
	}
	keys := map[string]bool{}
	var collect func(any) error
	collect = func(value any) error {
		switch item := value.(type) {
		case map[string]any:
			if drawing, _ := item["drawingId"].(string); drawing != "" {
				return fmt.Errorf("画板文件仅保存在浏览器中，请从画布导出完整工程")
			}
			if key, _ := item["storageKey"].(string); strings.TrimSpace(key) != "" {
				if !strings.HasPrefix(key, "resource:") || strings.TrimSpace(strings.TrimPrefix(key, "resource:")) == "" {
					return fmt.Errorf("工程含尚未保存的本地素材，请先完成素材保存")
				}
				keys[key] = true
			}
			for _, child := range item {
				if err := collect(child); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range item {
				if err := collect(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := collect(doc); err != nil {
		return err
	}
	ordered := make([]string, 0, len(keys))
	for key := range keys {
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	writer := zip.NewWriter(out)
	files := make([]map[string]any, 0, len(ordered))
	for index, key := range ordered {
		if err := ctx.Err(); err != nil {
			return err
		}
		media, err := source.OpenArchiveMedia(ctx, strings.TrimPrefix(key, "resource:"))
		if err != nil {
			return err
		}
		if media.Body == nil || media.Bytes <= 0 {
			if media.Body != nil {
				media.Body.Close()
			}
			return fmt.Errorf("工程素材尚未就绪")
		}
		ext := ".bin"
		if values, err := mime.ExtensionsByType(media.MimeType); err == nil && len(values) > 0 {
			ext = values[0]
		}
		name := fmt.Sprintf("projects/0/files/%04d%s", index, ext)
		entry, err := writer.Create(name)
		if err != nil {
			media.Body.Close()
			return err
		}
		n, copyErr := io.Copy(entry, media.Body)
		closeErr := media.Body.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if n != media.Bytes {
			return fmt.Errorf("工程素材字节数与保存记录不一致")
		}
		files = append(files, map[string]any{"storageKey": key, "path": name, "mimeType": media.MimeType, "bytes": n})
	}
	delete(doc, "remoteContentHash")
	// This is a single-project export. Its source library folder is not part of
	// the archive, so the imported project starts outside that folder.
	delete(doc, "folderId")
	manifest := map[string]any{"app": "infinite-canvas", "version": 4, "exportedAt": time.Now().UTC().Format(time.RFC3339), "projects": []any{map[string]any{"project": doc, "files": files}}}
	entry, err := writer.Create("projects.json")
	if err != nil {
		return err
	}
	if err = json.NewEncoder(entry).Encode(manifest); err != nil {
		return err
	}
	return writer.Close()
}
