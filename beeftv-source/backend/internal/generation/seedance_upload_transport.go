package generation

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type referenceUploadContextKey struct{}

// ReferenceUploadMeta identifies a local preparation call without retaining a
// resource id, filename, payload or signed storage URL.
type ReferenceUploadMeta struct {
	Kind    string
	Index   int
	Stage   string
	Attempt int
}

func ReferenceUploadFromContext(ctx context.Context) (ReferenceUploadMeta, bool) {
	meta, ok := ctx.Value(referenceUploadContextKey{}).(ReferenceUploadMeta)
	return meta, ok
}

func (m ReferenceUploadMeta) Label() string {
	name := map[string]string{"image": "参考图", "video": "参考视频", "audio": "参考音频"}[m.Kind]
	if name == "" {
		name = "参考素材"
	}
	if m.Index > 0 {
		name += fmt.Sprintf(" %d", m.Index)
	}
	stage := map[string]string{"create": "申请上传", "put": "上传文件", "resume": "恢复上传", "complete": "确认上传", "abort": "取消上传"}[m.Stage]
	label := strings.TrimSpace(name + " " + stage)
	if m.Attempt > 0 {
		label += fmt.Sprintf("（第 %d 次）", m.Attempt)
	}
	return label
}

func withReferenceUpload(ctx context.Context, meta ReferenceUploadMeta) context.Context {
	return context.WithValue(ctx, referenceUploadContextKey{}, meta)
}

func referenceUploadStage(ctx context.Context, stage string) context.Context {
	meta, _ := ReferenceUploadFromContext(ctx)
	meta.Stage = stage
	return withReferenceUpload(WithRequestKind(ctx, "reference_"+stage), meta)
}

func referenceUploadAttempt(ctx context.Context, attempt int) context.Context {
	meta, _ := ReferenceUploadFromContext(ctx)
	meta.Attempt = attempt
	return withReferenceUpload(ctx, meta)
}

// ReferenceUploadError proves that preparation failed before model dispatch.
// Cause stays available in process; Error exposes only scrubbed diagnostic text.
type ReferenceUploadError struct {
	Meta           ReferenceUploadMeta
	HTTPStatus     int
	Code           string
	RequestID      string
	Detail         string
	Cause          error
	Dispatched     bool
	TransportPhase string
}

func (e *ReferenceUploadError) Error() string {
	return e.Meta.Label() + "失败：" + DiagnosticSummary(e.Detail)
}
func (e *ReferenceUploadError) Unwrap() error { return e.Cause }
func (e *ReferenceUploadError) Is(target error) bool {
	return e.Meta.Stage == "put" && target == errBeefAPISeedanceUploadUnavailable
}

func referenceUploadError(ctx context.Context, cause error) *ReferenceUploadError {
	var upload *ReferenceUploadError
	if errors.As(cause, &upload) {
		return upload
	}
	meta, _ := ReferenceUploadFromContext(ctx)
	upload = &ReferenceUploadError{Meta: meta, Cause: cause, Detail: cause.Error()}
	var httpErr HTTPError
	if errors.As(cause, &httpErr) {
		upload.HTTPStatus, upload.RequestID = httpErr.StatusCode, sanitizeDebugID(httpErr.RequestID)
		fields := extractProviderFields(httpErr.Body)
		upload.Code = sanitizeProviderCode(fields.Code)
		upload.RequestID = firstNonEmpty(upload.RequestID, sanitizeDebugID(fields.RequestID))
		upload.Detail = firstNonEmpty(fields.Message, http.StatusText(httpErr.StatusCode))
	}
	upload.Detail = DiagnosticSummary(upload.Detail)
	return upload
}

func referenceUploadAddressError(ctx context.Context, cause error) *ReferenceUploadError {
	upload := referenceUploadError(referenceUploadStage(ctx, "put"), cause)
	upload.Code = "upload_address_invalid"
	// These are local DNS validation results, never upstream-provided messages.
	if strings.Contains(cause.Error(), "外部服务域名解析失败") || strings.Contains(cause.Error(), "外部服务域名没有可用地址") {
		upload.Code = "upload_transport_error"
	}
	return upload
}

func inlineAfterReferencePutFailure(ctx context.Context, input *Input, read BeefAPISeedanceMediaReader, err error) error {
	var upload *ReferenceUploadError
	if ctx.Err() != nil || !errors.As(err, &upload) || upload.Meta.Stage != "put" ||
		errors.Is(err, errBeefAPISeedanceUploadRedirect) ||
		(upload.Code != "upload_transport_error" && upload.HTTPStatus != 403 && upload.HTTPStatus != 408 && upload.HTTPStatus != 429 && upload.HTTPStatus < 500) {
		return err
	}
	// No model request exists yet. Reuse the gateway's existing bounded inline
	// contract, never retry generation or send storage credentials to the gateway.
	if fallbackErr := FallbackBeefAPISeedanceInline(ctx, input, read); fallbackErr != nil {
		if errors.Is(fallbackErr, ErrVideoJSONRequestTooLarge) {
			return err
		}
		return fallbackErr
	}
	return nil
}
