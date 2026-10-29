package generation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/outbound"
)

const (
	beefAPISeedanceUploadCreatePath    = "/video-references/uploads"
	beefAPISeedanceUploadCompletePath  = "/video-references/uploads/complete"
	beefAPISeedanceUploadResponseLimit = int64(1 << 20)
	beefAPISeedanceJSONOverheadBytes   = int64(64 << 10)
	beefAPISeedanceImageMaxBytes       = int64(30 << 20)
	beefAPISeedanceVideoMaxBytes       = int64(200 << 20)
	beefAPISeedanceAudioMaxBytes       = int64(15 << 20)
	beefAPISeedanceUploadTimeout       = 15 * time.Minute
)

var (
	errBeefAPISeedanceUploadRedirect    = errors.New("参考素材上传不允许重定向")
	errBeefAPISeedanceUploadUnavailable = errors.New("暂时无法接收参考素材")
	errBeefAPISeedanceUploadIncomplete  = errors.New("参考素材未能确认，请重新提交")
	errBeefAPISeedanceUploadFormat      = errors.New("无法识别文件。图片用 PNG、JPEG、WebP、GIF、BMP 或 TIFF。视频用 MP4 或 MOV。音频用 MP3 或 WAV。")
	errBeefAPISeedanceUploadEmpty       = errors.New("参考素材为空，请重新导入")
)

const (
	BeefAPISeedanceImageMaxBytes = beefAPISeedanceImageMaxBytes
	BeefAPISeedanceVideoMaxBytes = beefAPISeedanceVideoMaxBytes
	BeefAPISeedanceUploadTimeout = beefAPISeedanceUploadTimeout
)

var (
	ErrBeefAPISeedanceUploadUnavailable = errBeefAPISeedanceUploadUnavailable
	ErrBeefAPISeedanceUploadIncomplete  = errBeefAPISeedanceUploadIncomplete
)

type BeefAPISeedanceMediaReader func(kind string, media Media) (data []byte, mime string, skip bool, err error)

type BeefAPISeedanceUploadSession struct {
	UploadURL       string                        `json:"upload_url"`
	UploadMethod    string                        `json:"upload_method"`
	RequiredHeaders map[string]string             `json:"required_headers"`
	Ticket          string                        `json:"ticket"`
	Multipart       *BeefAPISeedanceMultipartPlan `json:"multipart,omitempty"`
}

type BeefAPISeedanceUploadComplete struct {
	URL    string `json:"url"`
	Kind   string `json:"kind"`
	Mime   string `json:"mime"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type BeefAPISeedanceUploadRequest struct {
	Resumable bool   `json:"resumable,omitempty"`
	Kind      string `json:"kind"`
	Bytes     int64  `json:"bytes"`
	SHA256    string `json:"sha256"`
	Mime      string `json:"mime"`
}

// PrepareBeefAPIVideoReferences uploads built-in BeefAPI local/inline
// references through the same generation key, then rewrites each item to the
// completed HTTPS URL. PUT uses only the returned headers and known length.
// Only Seedance allows recoverable PUT failures or a first-create 404/501
// to fall back within its existing 64 MiB inline wire limit;
// HTTP-only contracts must never fall back to inline or asset:// references.
func PrepareBeefAPIVideoReferences(ctx context.Context, config Config, input *Input, read BeefAPISeedanceMediaReader) (err error) {
	requiresHTTP := requiresBeefAPIHTTPReferences(ctx, config)
	if input == nil || (!requiresHTTP && !IsBeefAPISeedancePreuploadConfig(ctx, config)) {
		return nil
	}
	defer func() {
		if requiresHTTP && err != nil {
			err = RequestPreparationError{Cause: err}
		}
	}()
	if err := ctx.Err(); err != nil {
		return err
	}
	if read == nil {
		read = ReadBeefAPISeedanceInlineMedia
	}
	started := false
	for _, group := range BeefAPISeedanceMediaGroups(input) {
		for index := range group.items {
			if err := ctx.Err(); err != nil {
				return err
			}
			media := &group.items[index]
			if SkipBeefAPISeedanceMedia(*media) {
				if requiresHTTP && !IsPublicMediaURL(strings.TrimSpace(media.URL)) {
					return errors.New("当前模型需要可访问的参考图片链接，请重新导入图片。本次尚未开始生成")
				}
				continue
			}
			if media.Bytes > 0 {
				if err := ValidateBeefAPISeedanceMediaSize(group.kind, media.Bytes); err != nil {
					return err
				}
			}
			data, mime, skip, err := read(group.kind, *media)
			if err != nil {
				return err
			}
			if skip {
				if requiresHTTP {
					return errors.New("参考素材未能读取，请重新导入图片。本次尚未开始生成")
				}
				continue
			}
			if err := ValidateBeefAPISeedanceMediaSize(group.kind, int64(len(data))); err != nil {
				return err
			}
			mime, err = CanonicalBeefAPISeedanceMime(group.kind, mime, data)
			if err != nil {
				return err
			}
			if group.kind == "video" && modelcatalog.IsSeedance2Family(config.InterfaceType, config.Model) {
				if err := applySeedance2VideoProbe(ctx, config, index, media, data); err != nil {
					return err
				}
			}
			if err := validateSeedanceReferenceCapability(input, group.kind, index, *media, int64(len(data))); err != nil {
				return err
			}
			digest := sha256.Sum256(data)
			hexDigest := hex.EncodeToString(digest[:])
			uploadCtx := withReferenceUpload(ctx, ReferenceUploadMeta{Kind: group.kind, Index: index + 1})
			uploadCtx, reporter := beginReferenceProgress(uploadCtx, referenceMediaLabel(group.kind, index), int64(len(data)))
			if runtime, ok := RuntimeFromContext(ctx); ok && runtime.Stages != nil {
				if err := runtime.Stages.SetStage(ctx, ReferenceUploadMeta{Kind: group.kind, Index: index + 1, Stage: "put"}.Label()); err != nil {
					return err
				}
			}
			session, err := CreateBeefAPISeedanceUpload(uploadCtx, config, BeefAPISeedanceUploadRequest{
				Kind:   group.kind,
				Bytes:  int64(len(data)),
				SHA256: hexDigest,
				Mime:   mime,
			})
			if !started && BeefAPISeedancePreuploadUnavailable(err) {
				if requiresHTTP {
					return errors.New("参考素材上传暂不可用，本次尚未开始生成。请稍后重试或使用可访问的图片链接")
				}
				return FallbackBeefAPISeedanceInline(ctx, input, read)
			}
			if err != nil {
				if requiresHTTP {
					return MapBeefAPISeedanceUploadError(err, false)
				}
				return inlineAfterReferencePutFailure(uploadCtx, input, read, MapBeefAPISeedanceUploadError(err, false))
			}
			started = true
			uploaded, err := CompleteBeefAPISeedanceUpload(uploadCtx, config, session, data)
			size := int64(len(data))
			data = nil
			if err != nil {
				if requiresHTTP {
					return err
				}
				return inlineAfterReferencePutFailure(uploadCtx, input, read, err)
			}
			if uploaded.Kind != group.kind || uploaded.Bytes != size || uploaded.SHA256 != hexDigest {
				return errBeefAPISeedanceUploadIncomplete
			}
			if _, ok := CanonicalBeefAPISeedanceDeclaredMime(group.kind, uploaded.Mime); !ok {
				return errBeefAPISeedanceUploadIncomplete
			}
			media.URL = uploaded.URL
			media.DataURL = ""
			media.StorageKey = ""
			media.MimeType = firstNonEmpty(uploaded.Mime, mime)
			media.Bytes = size
			if uploaded.Bytes > 0 {
				media.Bytes = uploaded.Bytes
			}
			reporter.report("processing", size)
		}
	}
	return nil
}

type BeefAPISeedanceMediaGroup struct {
	kind  string
	items []Media
}

func BeefAPISeedanceMediaGroups(input *Input) []BeefAPISeedanceMediaGroup {
	return []BeefAPISeedanceMediaGroup{
		{"image", input.ReferenceImages},
		{"video", input.ReferenceVideos},
		{"audio", input.ReferenceAudios},
	}
}

func SkipBeefAPISeedanceMedia(media Media) bool {
	value := strings.TrimSpace(media.URL)
	if strings.HasPrefix(value, "asset://") {
		return true
	}
	return IsPublicMediaURL(value)
}

func ReadBeefAPISeedanceInlineMedia(_ string, media Media) ([]byte, string, bool, error) {
	if SkipBeefAPISeedanceMedia(media) {
		return nil, "", true, nil
	}
	if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(strings.TrimSpace(raw), "data:") {
		mimeType, data, err := DecodeProviderDataURL(raw)
		if err != nil {
			return nil, "", false, err
		}
		return data, firstNonEmpty(media.MimeType, mimeType), false, nil
	}
	if strings.HasPrefix(media.StorageKey, "resource:") {
		return nil, "", false, errors.New("参考素材未能读取，请重新提交")
	}
	return nil, "", true, nil
}

func ownedSeedanceMediaReader(ctx context.Context, userID string) BeefAPISeedanceMediaReader {
	return func(kind string, media Media) ([]byte, string, bool, error) {
		if SkipBeefAPISeedanceMedia(media) {
			return nil, "", true, nil
		}
		if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(strings.TrimSpace(raw), "data:") {
			return ReadBeefAPISeedanceInlineMedia(kind, media)
		}
		if !strings.HasPrefix(media.StorageKey, "resource:") {
			return nil, "", true, nil
		}
		if media.Bytes > 0 {
			if err := ValidateBeefAPISeedanceMediaSize(kind, media.Bytes); err != nil {
				return nil, "", false, err
			}
		}
		runtime, ok := RuntimeFromContext(ctx)
		if !ok || runtime.Resources == nil {
			return nil, "", false, errors.New("读取任务参考资源失败：资源端口未接入")
		}
		resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
		resource, body, err := runtime.Resources.Open(userID, resourceID)
		if err != nil {
			return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
		}
		defer body.Close()
		max := BeefAPISeedanceKindMaxBytes(kind)
		data, err := io.ReadAll(io.LimitReader(body, max+1))
		if err != nil {
			return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
		}
		return data, firstNonEmpty(media.MimeType, resource.MimeType), false, nil
	}
}

func FallbackBeefAPISeedanceInline(ctx context.Context, input *Input, read BeefAPISeedanceMediaReader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var total int64
	for _, group := range BeefAPISeedanceMediaGroups(input) {
		for index := range group.items {
			if err := ctx.Err(); err != nil {
				return err
			}
			media := &group.items[index]
			if SkipBeefAPISeedanceMedia(*media) {
				continue
			}
			if DataURL := strings.TrimSpace(firstNonEmpty(media.DataURL, media.URL)); strings.HasPrefix(DataURL, "data:") {
				if total+int64(len(DataURL))+beefAPISeedanceJSONOverheadBytes > VideoJSONRequestLimitBytes {
					return ErrVideoJSONRequestTooLarge
				}
			}
			if media.Bytes > 0 {
				if media.Bytes > int64(^uint(0)>>1) {
					return ErrVideoJSONRequestTooLarge
				}
				estimated := int64(base64.StdEncoding.EncodedLen(int(media.Bytes))) + 128
				if total+estimated+beefAPISeedanceJSONOverheadBytes > VideoJSONRequestLimitBytes {
					return ErrVideoJSONRequestTooLarge
				}
			}
			data, mime, skip, err := read(group.kind, *media)
			if err != nil {
				return err
			}
			if skip {
				continue
			}
			if err := ValidateBeefAPISeedanceMediaSize(group.kind, int64(len(data))); err != nil {
				return err
			}
			mime, err = CanonicalBeefAPISeedanceMime(group.kind, mime, data)
			if err != nil {
				return err
			}
			if group.kind == "video" && modelcatalog.IsSeedance2Family(input.Config.InterfaceType, input.Config.Model) {
				if err := applySeedance2VideoProbe(ctx, input.Config, index, media, data); err != nil {
					return err
				}
			}
			if err := validateSeedanceReferenceCapability(input, group.kind, index, *media, int64(len(data))); err != nil {
				return err
			}
			size := int64(len(data))
			encoded := DataURL(mime, data)
			data = nil
			total += int64(len(encoded))
			if total+beefAPISeedanceJSONOverheadBytes > VideoJSONRequestLimitBytes {
				return ErrVideoJSONRequestTooLarge
			}
			media.DataURL = encoded
			media.URL = ""
			media.MimeType = mime
			media.Bytes = size
		}
	}
	return nil
}

func validateSeedanceReferenceCapability(input *Input, kind string, index int, media Media, size int64) error {
	if input.VideoCapability == nil {
		return nil
	}
	media.Bytes = size
	refs := input.VideoCapability.References
	applySeedanceDocumentedVideoPixelFloor(input.Config, &refs)
	switch kind {
	case "image":
		return validateVideoReferenceImage(refs, index, media)
	case "video":
		return validateVideoReferenceVideo(refs, index, media)
	}
	return nil
}

func CreateBeefAPISeedanceUpload(ctx context.Context, config Config, request BeefAPISeedanceUploadRequest) (BeefAPISeedanceUploadSession, error) {
	ctx = referenceUploadStage(ctx, "create")
	request.Resumable = true
	var session BeefAPISeedanceUploadSession
	if err := PostJSON(ctx, config, beefAPISeedanceUploadCreatePath, request, &session); err != nil {
		return BeefAPISeedanceUploadSession{}, referenceUploadError(ctx, err)
	}
	if err := ValidateBeefAPISeedanceSession(ctx, session); err != nil {
		return BeefAPISeedanceUploadSession{}, referenceUploadAddressError(ctx, err)
	}
	return session, nil
}

func CompleteBeefAPISeedanceUpload(ctx context.Context, config Config, session BeefAPISeedanceUploadSession, data []byte) (BeefAPISeedanceUploadComplete, error) {
	if session.Multipart != nil {
		return completeBeefAPISeedanceMultipart(ctx, config, session, data)
	}
	return completeBeefAPISeedanceSingle(ctx, config, session, data)
}

func BeefAPISeedancePutTimeout(ctx context.Context) time.Duration {
	timeout := beefAPISeedanceUploadTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 && remaining < timeout {
			return remaining
		}
	}
	return timeout
}

func PutBeefAPISeedanceBytes(ctx context.Context, session BeefAPISeedanceUploadSession, data []byte) (resultErr error) {
	ctx = referenceUploadStage(ctx, "put")
	if err := ctx.Err(); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, strings.TrimSpace(session.UploadURL), referenceUploadReader(ctx, bytes.NewReader(data)))
	if err != nil {
		return errBeefAPISeedanceUploadUnavailable
	}
	req.ContentLength = int64(len(data))
	req.GetBody = nil
	for name, value := range session.RequiredHeaders {
		if SkipBeefAPISeedancePutHeader(name) {
			continue
		}
		req.Header.Set(name, value)
	}
	req.Header.Del("Authorization")
	req.Header.Del("Proxy-Authorization")
	req.Header.Del("Cookie")
	req.Header.Del("X-Api-Key")
	req.Header.Del("X-Goog-Api-Key")
	outbound.ApplyDefaultOutboundHeaders(req)
	trace := &transportTrace{}
	req = trace.attach(req)
	observation := TransportObservation{Request: req, StartedAt: time.Now(), ResponseLimitBytes: beefAPISeedanceUploadResponseLimit}
	defer func() {
		observation.Dispatched, observation.TransportPhase = trace.result(resultErr)
		var upload *ReferenceUploadError
		if errors.As(resultErr, &upload) {
			upload.Dispatched, upload.TransportPhase = observation.Dispatched, observation.TransportPhase
		}
		observation.Err = resultErr
		// A storage error body can echo signed headers and credentials. Only the
		// typed, allowlisted code and scrubbed summary reach persisted receipts.
		if runtime, ok := RuntimeFromContext(ctx); ok && runtime.Receipts != nil {
			runtime.Receipts.Observe(observation)
		}
	}()
	if err := ValidateBeefAPISeedanceSecureURL(req.Context(), session.UploadURL); err != nil {
		return referenceUploadAddressError(ctx, err)
	}
	client := outbound.OutboundHTTPClient(BeefAPISeedancePutTimeout(ctx))
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errBeefAPISeedanceUploadRedirect
	}
	observation.TransportRoute = "direct"
	if transport, ok := client.Transport.(*http.Transport); ok && transport.Proxy != nil {
		if proxy, proxyErr := transport.Proxy(req); proxyErr == nil && proxy != nil {
			observation.TransportRoute = "proxy"
		}
	}
	resp, err := client.Do(req)
	observation.Dispatched, observation.TransportPhase = trace.result(err)
	if err != nil {
		upload := referenceUploadError(ctx, err)
		upload.Code = "upload_transport_error"
		if resp != nil {
			upload.HTTPStatus, observation.StatusCode, observation.HTTPStatus = resp.StatusCode, resp.StatusCode, resp.StatusCode
		}
		return upload
	}
	defer resp.Body.Close()
	observation.StatusCode, observation.HTTPStatus = resp.StatusCode, resp.StatusCode
	observation.DeclaredResponseBytes = resp.ContentLength
	observation.RequestID = sanitizeDebugID(firstNonEmpty(resp.Header.Get("X-Amz-Request-Id"), resp.Header.Get("X-Request-Id"), resp.Header.Get("Cf-Ray")))
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, beefAPISeedanceUploadResponseLimit+1))
	observation.ReceivedBytes = int64(len(body))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		upload := referenceUploadError(ctx, errBeefAPISeedanceUploadUnavailable)
		upload.HTTPStatus, upload.RequestID = resp.StatusCode, observation.RequestID
		upload.Detail = fmt.Sprintf("HTTP %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
		var storageError struct {
			Code      string `xml:"Code"`
			RequestID string `xml:"RequestId"`
		}
		if xml.Unmarshal(body, &storageError) == nil {
			upload.Code = sanitizeProviderCode(storageError.Code)
			upload.RequestID = firstNonEmpty(upload.RequestID, sanitizeDebugID(storageError.RequestID))
		}
		upload.Detail += " " + upload.Code
		return upload
	}
	if readErr != nil {
		upload := referenceUploadError(ctx, readErr)
		upload.Code = "upload_transport_error"
		upload.HTTPStatus, upload.RequestID = resp.StatusCode, observation.RequestID
		return upload
	}
	return nil
}

func ValidateBeefAPISeedanceSession(ctx context.Context, session BeefAPISeedanceUploadSession) error {
	if strings.TrimSpace(session.Ticket) == "" {
		return errBeefAPISeedanceUploadUnavailable
	}
	if session.Multipart != nil {
		return validateSeedanceMultipart(ctx, session.Multipart, 0)
	}
	method := strings.ToUpper(strings.TrimSpace(session.UploadMethod))
	if method != "" && method != http.MethodPut {
		return errBeefAPISeedanceUploadUnavailable
	}
	if err := ValidateBeefAPISeedanceSecureURL(ctx, session.UploadURL); err != nil {
		return err
	}
	return nil
}

func ValidateBeefAPISeedanceSecureURL(ctx context.Context, raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !parsed.IsAbs() || parsed.Hostname() == "" || parsed.User != nil {
		return errBeefAPISeedanceUploadUnavailable
	}
	if parsed.Scheme != "https" && !BeefAPISeedanceAllowInsecureTestURL(ctx, parsed) {
		return errBeefAPISeedanceUploadUnavailable
	}
	if _, err := outbound.ValidateOutboundURLContext(ctx, parsed.String()); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("%w：%s", errBeefAPISeedanceUploadUnavailable, DiagnosticSummary(err.Error()))
	}
	return nil
}

func BeefAPISeedanceAllowInsecureTestURL(ctx context.Context, parsed *url.URL) bool {
	return parsed != nil && parsed.Scheme == "http" && beefAPITestBaseURL(ctx) != ""
}

func SkipBeefAPISeedancePutHeader(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-length", "connection", "transfer-encoding", "te", "trailer", "upgrade", "x-api-key", "x-goog-api-key":
		return true
	default:
		return strings.HasPrefix(strings.ToLower(strings.TrimSpace(name)), "x-canvas-")
	}
}

func BeefAPISeedancePreuploadUnavailable(err error) bool {
	var httpErr HTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	return httpErr.StatusCode == http.StatusNotFound || httpErr.StatusCode == http.StatusNotImplemented
}

func MapBeefAPISeedanceUploadError(err error, completing bool) error {
	if err == nil {
		return nil
	}
	var upload *ReferenceUploadError
	if errors.As(err, &upload) {
		return err
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if errors.Is(err, errBeefAPISeedanceUploadRedirect) {
		return errBeefAPISeedanceUploadUnavailable
	}
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		switch httpErr.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return err
		case http.StatusServiceUnavailable, http.StatusBadGateway, http.StatusGatewayTimeout:
			return errBeefAPISeedanceUploadUnavailable
		case http.StatusBadRequest:
			if message := BeefAPISeedanceUserErrorMessage(httpErr.Body); message != "" {
				return errors.New(message)
			}
			if completing {
				return errBeefAPISeedanceUploadIncomplete
			}
			return errors.New("请检查文件类型、大小后再提交")
		}
	}
	if completing {
		return errBeefAPISeedanceUploadIncomplete
	}
	return errBeefAPISeedanceUploadUnavailable
}

func BeefAPISeedanceUserErrorMessage(body string) string {
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(body), &payload) != nil {
		return ""
	}
	message := strings.TrimSpace(payload.Error.Message)
	if message == "" {
		return ""
	}
	lower := strings.ToLower(message)
	if strings.Contains(lower, "ticket") || strings.Contains(lower, "sha256") || strings.Contains(lower, "r2") || strings.Contains(lower, "upload_url") {
		return ""
	}
	return message
}

func BeefAPISeedanceKindMaxBytes(kind string) int64 {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		return beefAPISeedanceImageMaxBytes
	case "video":
		return beefAPISeedanceVideoMaxBytes
	case "audio":
		return beefAPISeedanceAudioMaxBytes
	default:
		return 0
	}
}

func ValidateBeefAPISeedanceMediaSize(kind string, size int64) error {
	if size <= 0 {
		return errBeefAPISeedanceUploadEmpty
	}
	max := BeefAPISeedanceKindMaxBytes(kind)
	if max <= 0 {
		return errBeefAPISeedanceUploadFormat
	}
	if size > max {
		switch kind {
		case "image":
			return errors.New("参考图片不能超过 30MB")
		case "video":
			return errors.New("参考视频不能超过 200MB")
		case "audio":
			return errors.New("参考音频不能超过 15MB")
		default:
			return errBeefAPISeedanceUploadFormat
		}
	}
	return nil
}

func CanonicalBeefAPISeedanceMime(kind string, declared string, data []byte) (string, error) {
	if mime, ok := CanonicalBeefAPISeedanceDeclaredMime(kind, declared); ok {
		return mime, nil
	}
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	if mime, ok := CanonicalBeefAPISeedanceDeclaredMime(kind, detected); ok {
		return mime, nil
	}
	return "", errBeefAPISeedanceUploadFormat
}

func CanonicalBeefAPISeedanceDeclaredMime(kind, raw string) (string, bool) {
	mime := strings.ToLower(strings.TrimSpace(raw))
	if slash := strings.IndexByte(mime, ';'); slash >= 0 {
		mime = strings.TrimSpace(mime[:slash])
	}
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		switch mime {
		case "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff":
			return mime, true
		case "image/jpg":
			return "image/jpeg", true
		}
	case "video":
		switch mime {
		case "video/mp4", "video/quicktime":
			return mime, true
		}
	case "audio":
		switch mime {
		case "audio/mpeg", "audio/mp3":
			return "audio/mpeg", true
		case "audio/wav", "audio/wave", "audio/x-wav":
			return "audio/wav", true
		}
	}
	return "", false
}
