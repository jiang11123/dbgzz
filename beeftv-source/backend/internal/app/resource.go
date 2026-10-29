package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"infinite-canvas/backend/internal/kernel"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

const providerResourceURLTTL = 4 * time.Hour
const directResourceURLTTL = 5 * time.Minute

type ResourceStream = assets.ResourceStream
type ResourceDeliveryOptions = assets.ResourceDeliveryOptions
type ResourceDelivery = assets.ResourceDelivery

func (s *Service) resourceDomain() *localasset.Service {
	if s == nil {
		return localasset.NewService(localasset.Dependencies{})
	}
	s.assetsOnce.Do(func() {
		if s.assets != nil {
			return
		}
		s.assets = localasset.NewService(localasset.Dependencies{
			Repository:   localasset.NewRepository(s.repo),
			Blobs:        localasset.NewFileStore(s.dataDir),
			Quota:        resourceQuota{svc: s},
			Lifecycle:    resourceLifecycle{svc: s},
			LocalStorage: s.localResourceStorage || s.IsLocalMode(),
			DataDir:      s.dataDir,
		})
	})
	return s.assets
}

// localResourceUnavailable is the single storage-boundary check used by all
// read and delivery paths. A local workspace must never fall through to a
// historical OSS provider, even if an old database row still contains one.
func (s *Service) localResourceUnavailable(resource *model.Resource) bool {
	return s.localResourceStorage && (resource == nil || resource.Provider != "local")
}

func (s *Service) Resources(userID string, limit int) ([]model.Resource, error) {
	return s.resourceDomain().Resources(userID, limit)
}

func (s *Service) Resource(userID string, id string) (*model.Resource, error) {
	return s.resourceDomain().Resource(userID, id)
}

func (s *Service) EnsureResourceMediaMetadata(ctx context.Context, userID, id string) (*model.Resource, error) {
	return s.resourceDomain().EnsureMediaMetadata(ctx, userID, id)
}

// DirectResourceURL 仅为本地文件签发短时下载地址。
func (s *Service) DirectResourceURL(userID string, id string) (string, error) {
	resource, err := s.resourceDomain().Resource(userID, id)
	if err != nil {
		return "", err
	}
	return s.directResourceURL(resource, time.Now().Add(directResourceURLTTL))
}

func (s *Service) directResourceURL(resource *model.Resource, expiresAt time.Time) (string, error) {
	if resource == nil {
		return "", errors.New("资源不存在")
	}
	if resource.Status != model.ResourceStatusReady {
		return "", BadAuthRequest("资源尚未上传完成")
	}
	if resource.Provider != "local" {
		return "", BadAuthRequest("资源不在本地存储中")
	}
	return s.signedPublicResourceURL(resource, expiresAt)
}

// PrepareResourceDelivery 统一决定浏览器资源出口：配置 CDN 时默认直连 CDN，显式代理仅用于需要同源 Blob 的内部读取。
func (s *Service) PrepareResourceDelivery(userID string, id string, options ResourceDeliveryOptions) (*ResourceDelivery, error) {
	return s.resourceDomain().PrepareDelivery(userID, id, options)
}

func (s *Service) prepareResourceDelivery(userID string, resource *model.Resource, options ResourceDeliveryOptions) (*ResourceDelivery, error) {
	return s.resourceDomain().PrepareOwnedDelivery(userID, resource, options)
}

func (s *Service) signedPublicResourceURL(resource *model.Resource, expiresAt time.Time) (string, error) {
	if resource == nil {
		return "", errors.New("资源不存在")
	}
	baseURL, err := s.publicResourceBaseURL()
	if err != nil {
		return "", err
	}
	expires := strconv.FormatInt(expiresAt.UTC().Unix(), 10)
	signature, err := s.signPublicResource(resource.ID, expires)
	if err != nil {
		return "", err
	}
	ext := resourceFileExtension(resource.ObjectKey, resource.MimeType, resource.Kind)
	filename := resource.ID
	if ext != "" {
		if !strings.HasPrefix(ext, ".") {
			ext = "." + ext
		}
		filename += ext
	}
	baseURL.Path = strings.TrimRight(baseURL.Path, "/") + "/api/public/resources/" + url.PathEscape(resource.ID) + "/file/" + url.PathEscape(filename)
	query := baseURL.Query()
	query.Set("expires", expires)
	query.Set("signature", signature)
	baseURL.RawQuery = query.Encode()
	return baseURL.String(), nil
}

func (s *Service) signedHTTPSPublicResourceURL(resource *model.Resource, expiresAt time.Time) (string, error) {
	baseURL, err := s.publicResourceBaseURL()
	if err != nil {
		return "", err
	}
	if baseURL.Scheme != "https" {
		return "", BadAuthRequest("私网或 HTTP S3 用于上游资源时，服务器公开访问地址必须使用 HTTPS")
	}
	return s.signedPublicResourceURL(resource, expiresAt)
}

func (s *Service) verifyPublicResourceSignature(resourceID string, expires string, signature string) error {
	if strings.TrimSpace(signature) == "" || !decimalDigits(expires) {
		return Forbidden("匿名下载链接无效")
	}
	expiresAt, err := strconv.ParseInt(expires, 10, 64)
	if err != nil || time.Now().UTC().Unix() > expiresAt {
		return Forbidden("匿名下载链接已过期")
	}
	expected, err := s.signPublicResource(resourceID, expires)
	if err != nil {
		return err
	}
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return Forbidden("匿名下载链接无效")
	}
	return nil
}

func (s *Service) signPublicResource(resourceID string, expires string) (string, error) {
	key, err := s.settingsEncryptionKey()
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(resourceID + "\n" + expires))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (s *Service) publicResourceBaseURL() (*url.URL, error) {
	raw := strings.TrimSpace(os.Getenv("CANVAS_PUBLIC_BASE_URL"))
	if raw == "" {
		return nil, BadAuthRequest("本地资源尚未配置上游可访问地址，请设置 CANVAS_PUBLIC_BASE_URL")
	}
	return validatePublicResourceBaseURL(raw)
}

func validatePublicResourceBaseURL(raw string) (*url.URL, error) {
	parsed, err := ValidateOutboundURL(raw)
	if err != nil {
		return nil, err
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, BadAuthRequest("服务器访问地址不能包含查询参数或片段")
	}
	if strings.HasSuffix(strings.TrimRight(parsed.Path, "/"), "/api") {
		return nil, BadAuthRequest("服务器访问地址请填写根地址，不要包含 /api")
	}
	return parsed, nil
}

func (s *Service) UploadResource(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	return s.resourceDomain().Upload(userID, header, kind, width, height, durationMs, uploadIdentity...)
}

func (s *Service) UploadLocalResource(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	return s.resourceDomain().UploadLocal(userID, header, kind, width, height, durationMs, uploadIdentity...)
}

func (s *Service) uploadLocalResource(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	return s.resourceDomain().UploadLocal(userID, header, kind, width, height, durationMs, uploadIdentity...)
}

func (s *Service) UploadResourceFile(userID string, fileName string, size int64, kind string, width int, height int, durationMs int64, file io.ReadSeeker, uploadIdentity ...string) (*model.Resource, error) {
	return s.resourceDomain().UploadFile(userID, fileName, size, kind, width, height, durationMs, file, uploadIdentity...)
}

func (s *Service) UploadLocalResourceFile(userID string, fileName string, size int64, kind string, width int, height int, durationMs int64, file io.ReadSeeker, uploadIdentity ...string) (*model.Resource, error) {
	return s.resourceDomain().UploadLocalFile(userID, fileName, size, kind, width, height, durationMs, file, uploadIdentity...)
}

func (s *Service) StartChunkedResourceUpload(userID string, req localasset.ChunkedUploadStart) (localasset.ChunkedUploadSessionInfo, error) {
	return s.resourceDomain().StartChunkedUpload(userID, req)
}

func (s *Service) PutChunkedResourceUpload(userID string, uploadID string, index int, body io.Reader) error {
	return s.resourceDomain().PutChunkedUpload(userID, uploadID, index, body)
}

func (s *Service) CompleteChunkedResourceUpload(userID string, uploadID string) (*model.Resource, error) {
	return s.resourceDomain().CompleteChunkedUpload(userID, uploadID)
}

func (s *Service) ImportResourceURL(userID string, rawURL string, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	if s.IsLocalMode() {
		return nil, localasset.RemoteImportForbidden()
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	payload, err := downloadRemoteResource(rawURL, megabytes(policy.Resource.ResourceUploadMB))
	if err != nil {
		return nil, err
	}
	kind = normalizeResourceKind(kind, payload.mimeType)
	if kind == "image" && (width <= 0 || height <= 0) {
		if decodedWidth, decodedHeight := imageDimensions(payload.data); decodedWidth > 0 && decodedHeight > 0 {
			width = decodedWidth
			height = decodedHeight
		}
	}
	size := int64(len(payload.data))
	return s.resourceDomain().IngestUpload(userID, kind, payload.fileName, payload.mimeType, size, width, height, durationMs, bytes.NewReader(payload.data), uploadIdentity...)
}

func normalizedResourceUploadKey(values []string) *string {
	return localasset.NormalizedUploadKey(values)
}

func (s *Service) resourceForUploadKey(userID string, uploadKey *string) (*model.Resource, error) {
	if uploadKey == nil {
		return nil, nil
	}
	resource, err := s.repo.ResourceByUploadKey(userID, *uploadKey)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return resource, err
}

func resourceUploadInProgress() *AppError {
	err := localasset.UploadInProgress()
	if appErr, ok := err.(*AppError); ok {
		return appErr
	}
	conflict := NewAppError(http.StatusConflict, err.Error())
	conflict.Retryable = true
	return conflict
}

func (s *Service) OpenResource(userID string, id string) (*model.Resource, io.ReadCloser, error) {
	return s.resourceDomain().Open(userID, id)
}

func (s *Service) OpenResourceRange(userID string, id string, rangeHeader string) (*ResourceStream, error) {
	return s.resourceDomain().OpenRange(userID, id, rangeHeader)
}

func (s *Service) OpenPublicResourceRange(id string, expires string, signature string, rangeHeader string) (*ResourceStream, error) {
	resource, err := s.repo.Resource(id)
	if err != nil {
		return nil, Forbidden("匿名下载链接无效")
	}
	if resource.Provider != "local" {
		return nil, Forbidden("匿名下载链接无效")
	}
	if err := s.verifyPublicResourceSignature(resource.ID, expires, signature); err != nil {
		return nil, err
	}
	return s.resourceDomain().OpenOwnedRange(resource.UserID, resource, rangeHeader)
}

func (s *Service) openResourceRange(userID string, resource *model.Resource, rangeHeader string) (*ResourceStream, error) {
	return s.resourceDomain().OpenOwnedRange(userID, resource, rangeHeader)
}

func (s *Service) storeResource(userID string, kind string, fileName string, mimeType string, size int64, width int, height int, durationMs int64, body io.Reader, uploadKey *string, forceLocal bool) (*model.Resource, bool, error) {
	_ = forceLocal
	return s.resourceDomain().Store(userID, kind, fileName, mimeType, size, width, height, durationMs, body, uploadKey)
}

func (s *Service) storeResourceObject(resource *model.Resource, fileName string, body io.Reader) (string, error) {
	return s.resourceDomain().WriteObject(resource, fileName, body)
}

func (s *Service) retryStoredResource(userID string, resource *model.Resource, kind string, mimeType string, size int64, body io.Reader, forceLocalFlag ...bool) (*model.Resource, error) {
	_ = forceLocalFlag
	if resource == nil {
		return nil, localasset.ResourceMissing()
	}
	return s.retryOwnedResource(userID, resource.ID, kind, mimeType, size, body)
}

func (s *Service) retryOwnedResource(userID string, resourceID string, kind string, mimeType string, size int64, body io.Reader) (*model.Resource, error) {
	return s.resourceDomain().RetryOwned(userID, resourceID, kind, mimeType, size, body)
}

func localObjectKey(userID string, kind string, fileName string, mimeType string, now time.Time) string {
	return localasset.ObjectKey(userID, kind, fileName, mimeType, now)
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

type remoteResourcePayload struct {
	url      string
	endpoint string
	fileName string
	mimeType string
	data     []byte
}

func downloadRemoteResource(rawURL string, maxBytes int64) (remoteResourcePayload, error) {
	parsed, err := validateRemoteResourceURL(rawURL)
	if err != nil {
		return remoteResourcePayload{}, err
	}
	client := OutboundHTTPClient(90 * time.Second)
	req, err := http.NewRequest(http.MethodGet, parsed.String(), nil)
	if err != nil {
		return remoteResourcePayload{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return remoteResourcePayload{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return remoteResourcePayload{}, fmt.Errorf("远程资源下载失败：%s", resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes))
	if err != nil {
		return remoteResourcePayload{}, err
	}
	if int64(len(data)) >= maxBytes {
		return remoteResourcePayload{}, BadAuthRequest(fmt.Sprintf("远程资源必须小于 %s", formatStorageLimit(maxBytes)))
	}
	mimeType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if idx := strings.Index(mimeType, ";"); idx >= 0 {
		mimeType = strings.TrimSpace(mimeType[:idx])
	}
	if mimeType == "" || mimeType == "application/octet-stream" {
		mimeType = http.DetectContentType(data)
	}
	fileName := path.Base(parsed.Path)
	if fileName == "" || fileName == "." || !strings.Contains(fileName, ".") {
		fileName = "resource." + extensionFromMimeType(mimeType)
	}
	return remoteResourcePayload{url: parsed.String(), endpoint: parsed.Host, fileName: fileName, mimeType: mimeType, data: data}, nil
}

func openRemoteResource(rawURL string) (io.ReadCloser, error) {
	parsed, err := validateRemoteResourceURL(rawURL)
	if err != nil {
		return nil, err
	}
	client := OutboundHTTPClient(90 * time.Second)
	resp, err := client.Get(parsed.String())
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, fmt.Errorf("远程资源读取失败：%s", resp.Status)
	}
	return resp.Body, nil
}

func validateRemoteResourceURL(rawURL string) (*url.URL, error) {
	return ValidateOutboundURL(rawURL)
}

func extensionFromMimeType(mimeType string) string {
	return localasset.ExtensionFromMimeType(mimeType)
}

func resourceFileExtension(fileName string, mimeType string, kind string) string {
	return localasset.FileExtension(fileName, mimeType, kind)
}

const imageHeaderDecodeLimit = 2 << 20

func imageDimensions(data []byte) (int, int) {
	width, height, err := imageHeaderDimensions(bytes.NewReader(data))
	if err != nil {
		return 0, 0
	}
	return width, height
}

func imageHeaderDimensions(r io.Reader) (int, int, error) {
	config, _, err := image.DecodeConfig(io.LimitReader(r, imageHeaderDecodeLimit))
	if err != nil {
		return 0, 0, err
	}
	return config.Width, config.Height, nil
}

func normalizeResourceKind(kind string, mimeType string) string {
	return localasset.NormalizeKind(kind, mimeType)
}

func normalizeSingleByteRange(value string) string {
	return localasset.NormalizeSingleByteRange(value)
}

func decimalDigits(value string) bool {
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func firstNonEmpty(values ...string) string {
	return kernel.FirstNonEmpty(values...)
}
