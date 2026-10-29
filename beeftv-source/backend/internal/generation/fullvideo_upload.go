package generation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"
)

type fullvideoUpload struct {
	ID        string  `json:"id"`
	Status    string  `json:"status"`
	Kind      string  `json:"type"`
	MIME      string  `json:"mime_type"`
	SHA256    string  `json:"sha256"`
	Bytes     int64   `json:"bytes"`
	ChunkSize int     `json:"chunk_size"`
	Received  []int   `json:"received"`
	Source    string  `json:"source"`
	Duration  float64 `json:"duration"`
}

func fullvideoMediaLimit(kind string) int64 {
	if kind == "image" {
		return 30 << 20
	}
	return 100_000_000
}

func ownedFullVideoMediaReader(ctx context.Context, userID string) BeefAPISeedanceMediaReader {
	return func(kind string, media Media) ([]byte, string, bool, error) {
		limit := fullvideoMediaLimit(kind)
		if media.Bytes > limit {
			return nil, "", false, errors.New("参考素材超过服务商大小限制")
		}
		if !strings.HasPrefix(media.StorageKey, "resource:") {
			return ReadBeefAPISeedanceInlineMedia(kind, media)
		}
		runtime, ok := RuntimeFromContext(ctx)
		if !ok || runtime.Resources == nil {
			return nil, "", false, errors.New("读取任务参考资源失败：资源端口未接入")
		}
		resource, body, err := runtime.Resources.Open(userID, strings.TrimPrefix(media.StorageKey, "resource:"))
		if err != nil {
			return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
		}
		defer body.Close()
		data, err := io.ReadAll(io.LimitReader(body, limit+1))
		if err == nil && int64(len(data)) > limit {
			err = errors.New("参考素材超过服务商大小限制")
		}
		return data, firstNonEmpty(media.MimeType, resource.MimeType), false, err
	}
}

// Uploads stay on the selected service and use the same key as generation.
// Any incomplete receipt stops before creating a billable task.
func prepareFullVideoReferences(ctx context.Context, input *Input, read BeefAPISeedanceMediaReader) error {
	if input == nil || input.Mode != "video" || input.Config.InterfaceType != "full-video" {
		return nil
	}
	if !fullvideoFullModel(input.Config.Model) {
		return errors.New("此协议仅支持全参 2.0 / 2.5")
	}
	maxTotal := 12
	if strings.HasSuffix(input.Config.Model, "2.5") {
		maxTotal = 50
	}
	if len(input.ReferenceImages)+len(input.ReferenceVideos)+len(input.ReferenceAudios) > maxTotal {
		return fmt.Errorf("当前模型最多支持 %d 个参考素材", maxTotal)
	}
	prepared := *input
	prepared.ReferenceImages = append([]Media(nil), input.ReferenceImages...)
	prepared.ReferenceVideos = append([]Media(nil), input.ReferenceVideos...)
	prepared.ReferenceAudios = append([]Media(nil), input.ReferenceAudios...)
	for _, group := range BeefAPISeedanceMediaGroups(&prepared) {
		for i := range group.items {
			media := &group.items[i]
			if raw := strings.TrimSpace(media.URL); strings.HasPrefix(raw, "https://") && media.StorageKey == "" {
				if _, err := outbound.ValidateOutboundURL(raw); err != nil {
					return err
				}
				if group.kind != "image" && media.DurationMs <= 0 {
					return errors.New("参考音视频缺少真实时长")
				}
				continue
			}
			data, mime, skip, err := read(group.kind, *media)
			if err != nil {
				return err
			}
			if skip || len(data) == 0 {
				return errors.New("无法读取参考素材，请重新导入")
			}
			if int64(len(data)) > fullvideoMediaLimit(group.kind) {
				return errors.New("参考素材超过服务商大小限制")
			}
			sum := sha256.Sum256(data)
			digest := hex.EncodeToString(sum[:])
			var receipt fullvideoUpload
			uploadCtx, reporter := beginReferenceProgress(ctx, referenceMediaLabel(group.kind, i), int64(len(data)))
			call := func(method, path, contentType string, body any) error {
				raw, e := ExecuteProtocolRequest(WithRequestKind(uploadCtx, "media_upload"), input.Config, protocol.RequestSpec{Method: method, Path: path, ContentType: contentType, Body: body, Auth: protocol.ManifestAuth{Type: "bearer", Field: "apiKey"}})
				if e != nil {
					return e
				}
				if method == "PUT" {
					return nil
				}
				var next fullvideoUpload
				if e := json.Unmarshal(raw, &next); e != nil {
					return e
				}
				receipt = next
				return nil
			}
			if err = call("POST", "/v1/media/uploads", "application/json", map[string]any{"size": len(data), "sha256": digest, "mime_type": mime}); err != nil {
				return err
			}
			if receipt.Status != "complete" {
				if !validFullVideoUploadID(receipt.ID) || receipt.ChunkSize <= 0 || receipt.ChunkSize > 16<<20 {
					return errors.New("素材上传回执无效")
				}
				path := "/v1/media/uploads/" + receipt.ID
				received := map[int]bool{}
				chunkCount := (len(data) + receipt.ChunkSize - 1) / receipt.ChunkSize
				for _, n := range receipt.Received {
					if n < 0 || n >= chunkCount || received[n] {
						return errors.New("素材上传分片回执无效")
					}
					received[n] = true
				}
				for start, n := 0, 0; start < len(data); start, n = start+receipt.ChunkSize, n+1 {
					if received[n] {
						reporter.resumeAt(int64(min(start+receipt.ChunkSize, len(data))))
						continue
					}
					end := min(start+receipt.ChunkSize, len(data))
					if err = call("PUT", fmt.Sprintf("%s/chunks/%d", path, n), "application/octet-stream", data[start:end]); err != nil {
						return err
					}
					reporter.report("transferring", int64(end))
				}
				reporter.report("processing", int64(len(data)))
				if err = call("POST", path+"/complete", "application/json", map[string]any{}); err != nil {
					return err
				}
			}
			if receipt.Status != "complete" || receipt.Bytes != int64(len(data)) || receipt.SHA256 != digest || receipt.Kind != group.kind || !trustedFullVideoAssetSource(input.Config.BaseURL, receipt.Source, input.Config.ReferenceAssetOrigin) {
				return errors.New("素材上传未通过完整性校验")
			}
			if _, err := outbound.ValidateOutboundURL(receipt.Source); err != nil {
				return err
			}
			if group.kind != "image" && receipt.Duration <= 0 {
				return errors.New("服务商未确认参考音视频时长")
			}
			media.URL = receipt.Source
			media.DataURL = ""
			media.StorageKey = ""
			media.Bytes = receipt.Bytes
			media.MimeType = receipt.MIME
			if group.kind != "image" {
				media.DurationMs = int64(receipt.Duration * 1000)
			}
		}
	}
	*input = prepared
	return nil
}

func validFullVideoUploadID(id string) bool {
	if id == "" {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func trustedFullVideoAssetSource(baseURL, sourceURL, assetOrigin string) bool {
	base, baseErr := url.Parse(baseURL)
	source, sourceErr := url.Parse(sourceURL)
	if baseErr != nil || sourceErr != nil || source.User != nil || source.Fragment != "" || !strings.HasPrefix(source.Path, "/v1/media/assets/") {
		return false
	}
	if source.Host == base.Host && (source.Scheme == "https" || (source.Scheme == "http" && base.Scheme == "http")) {
		return true
	}
	// Cross-origin assets require an exact origin explicitly configured by the
	// user. The host never sends the API credential to that asset origin.
	// An empty origin stays same-host only. A receipt cannot name an arbitrary LAN URL.
	allowed, err := url.Parse(strings.TrimSpace(assetOrigin))
	if err != nil || allowed.Scheme == "" || allowed.Host == "" || allowed.User != nil || allowed.RawQuery != "" || allowed.Fragment != "" || (allowed.Path != "" && allowed.Path != "/") || source.Scheme != allowed.Scheme || source.Host != allowed.Host {
		return false
	}
	if allowed.Scheme == "https" && (allowed.Port() == "" || allowed.Port() == "443") {
		return true
	}
	return (allowed.Scheme == "http" || allowed.Scheme == "https") && outbound.HostAllowsLocalHTTP(context.Background(), allowed.Hostname())
}

func fullvideoFullModel(name string) bool {
	switch name {
	case "sd-native-full-2.0", "sd-native-full-2.5", "原生不卡人脸-全参2.0", "原生不卡人脸-全参2.5":
		return true
	}
	return false
}
