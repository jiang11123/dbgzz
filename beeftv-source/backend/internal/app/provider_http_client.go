package app

// Provider 出站 HTTP、multipart 与媒体字节读取。实际传输在 generation。

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func withHTTPRequestRuntime(req *http.Request) *http.Request {
	if req == nil {
		return req
	}
	return req.WithContext(bindRequestReceipts(req.Context()))
}

func postGeminiJSON(ctx context.Context, config providerConfig, path string, body interface{}, target interface{}) error {
	return generation.PostGeminiJSON(bindRequestReceipts(ctx), config, path, body, target)
}

func getGeminiJSON(ctx context.Context, config providerConfig, path string, target interface{}) error {
	return generation.GetGeminiJSON(bindRequestReceipts(ctx), config, path, target)
}

func getGeminiBinary(ctx context.Context, config providerConfig, rawURL string) ([]byte, string, error) {
	return generation.GetGeminiBinary(bindRequestReceipts(ctx), config, rawURL)
}

func geminiVeoURL(baseURL string, path string) string {
	return generation.GeminiURL(baseURL, path)
}

func postStreamingBinary(ctx context.Context, config providerConfig, path string, body interface{}, onChunk func(string, []byte)) ([]byte, string, error) {
	return generation.PostStreamingBinary(bindRequestReceipts(ctx), config, path, body, onChunk)
}

func postJSON(ctx context.Context, config providerConfig, path string, body interface{}, target interface{}) error {
	return generation.PostJSON(bindRequestReceipts(ctx), config, path, body, target)
}

func postJSONWithSubmissionKey(ctx context.Context, config providerConfig, path string, body interface{}, target interface{}) error {
	ctx = bindRequestReceipts(ctx)
	if generation.SubmissionKeyFromContext(ctx) == "" {
		if key, ok := ctx.Value(providerSubmissionKeyContext{}).(string); ok {
			ctx = generation.WithSubmissionKey(ctx, key)
		}
	}
	return generation.PostJSONWithSubmissionKey(ctx, config, path, body, target)
}

func applyProviderAuth(req *http.Request, config providerConfig) {
	generation.ApplyAuth(req, config)
}

func postForm(ctx context.Context, config providerConfig, path string, contentType string, body io.Reader, target interface{}) error {
	return generation.PostForm(bindRequestReceipts(ctx), config, path, contentType, body, target)
}

func getJSON(ctx context.Context, config providerConfig, path string, target interface{}) error {
	return generation.GetJSON(bindRequestReceipts(ctx), config, path, target)
}

func postBinary(ctx context.Context, config providerConfig, path string, body interface{}) ([]byte, string, error) {
	return generation.PostBinary(bindRequestReceipts(ctx), config, path, body)
}

func getBinary(ctx context.Context, config providerConfig, path string) ([]byte, string, error) {
	return generation.GetBinary(bindRequestReceipts(ctx), config, path)
}

func getExternalBinary(ctx context.Context, rawURL string) ([]byte, string, error) {
	return generation.GetExternalBinary(bindRequestReceipts(ctx), rawURL)
}

func getProviderExternalBinary(ctx context.Context, config providerConfig, rawURL string) ([]byte, string, error) {
	return generation.GetProviderExternalBinary(bindRequestReceipts(ctx), config, rawURL)
}

func providerDownloadURL(baseURL string, rawURL string) string {
	return generation.ProviderDownloadURL(baseURL, rawURL)
}

func isBeefAPIHost(host string) bool {
	return generation.IsBeefAPIHost(host)
}

func sameProviderOrigin(baseURL string, rawURL string) bool {
	return generation.SameProviderOrigin(baseURL, rawURL)
}

func doJSON(req *http.Request, target interface{}) error {
	return generation.DoJSON(withHTTPRequestRuntime(req), target)
}

func doBinary(req *http.Request) ([]byte, string, error) {
	return generation.DoBinary(withHTTPRequestRuntime(req))
}

func doBinaryWithConsumer(req *http.Request, onChunk func(string, []byte)) ([]byte, string, error) {
	return generation.DoBinaryWithConsumer(withHTTPRequestRuntime(req), onChunk)
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	return generation.ParseRetryAfter(value, now)
}

func providerPollingDeadline(ctx context.Context) time.Time {
	return generation.PollingDeadline(ctx)
}

func apiURL(baseURL string, path string) string {
	return generation.APIURL(baseURL, path)
}

func ChannelAPIURL(baseURL string, path string) string {
	return generation.ChannelAPIURL(baseURL, path)
}

func ChannelAPIURLForProtocol(baseURL string, path string, interfaceType model.ChannelInterfaceType) string {
	return generation.ChannelAPIURLForProtocol(baseURL, path, interfaceType)
}

func writeField(writer *multipart.Writer, key string, value string) {
	_ = writer.WriteField(key, value)
}

func writeMediaPart(writer *multipart.Writer, field string, media providerMedia) error {
	raw, mimeType, err := mediaBytes(media)
	if err != nil {
		return err
	}
	filename := providerMediaFilename(media, mimeType)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": field, "filename": filename}))
	header.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	_, err = part.Write(raw)
	return err
}

func providerMediaFilename(media providerMedia, mimeType string) string {
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

func mediaBytes(media providerMedia) ([]byte, string, error) {
	return generation.MediaBytes(media)
}

func recordProviderRequest(service *Service, req *http.Request, startedAt time.Time, statusCode int, responseBody []byte, requestErr error) {
	if req == nil || service == nil {
		return
	}
	call := canonicalCallMeta(req.Context())
	status := model.ApiCallStatusSucceeded
	errorCode := ""
	errorText := ""
	if requestErr != nil || statusCode < 200 || statusCode >= 300 {
		status = model.ApiCallStatusFailed
		errorCode, errorText = providerRequestErrorDetails(requestErr)
	} else if businessCode, businessMessage, failed := providerResponseBusinessFailure(responseBody); failed {
		status = model.ApiCallStatusFailed
		errorCode = businessCode
		errorText = businessMessage
	}
	requestKind := providerRequestKind(req.Method, req.URL.Path)
	if call.RequestKind != "" {
		requestKind = call.RequestKind
	}
	if status == model.ApiCallStatusSucceeded && (requestKind == "create" || requestKind == "poll") && (call.Capability == "image" || call.Capability == "video") {
		service.syncProviderTaskProgress(call.TaskID, responseBody)
	}
	apiFormat := "openai"
	if req.Header.Get("x-goog-api-key") != "" {
		apiFormat = "gemini"
	}
	callLog := model.ApiCallLog{
		UserID: call.UserID, TraceID: call.TraceID, RequestID: call.RequestID, ChannelID: call.ChannelID, TaskID: call.TaskID,
		Source: "backend-task", Capability: call.Capability, Operation: call.Operation,
		RequestKind: requestKind,
		APIFormat:   apiFormat, Method: req.Method, Path: req.URL.Path, Model: call.Model,
		Status: status, StatusCode: statusCode, DurationMs: time.Since(startedAt).Milliseconds(),
		ErrorCode: errorCode, Error: errorText, ConcurrencyLimit: call.ConcurrencyLimit, UpstreamURL: req.URL.Scheme + "://" + req.URL.Host + req.URL.Path,
		ProviderRequestID: call.ProviderRequestID, RequestContentType: req.Header.Get("Content-Type"), RequestBody: requestPayloadForLog(req), ResponseBody: SanitizeAPICallPayload(responseBody, ""),
	}
	if code, message := ChannelSlotFailureDetails(requestErr); code != "" {
		callLog.ErrorCode = code
		callLog.Error = message
	}
	if requestKind == "create" && call.Capability == "video" {
		callLog.VideoSeconds = call.VideoSeconds
		if callLog.VideoSeconds <= 0 {
			if strings.Contains(strings.ToLower(call.Model), "seedance") || strings.Contains(req.URL.Path, "/contents/generations/tasks") {
				callLog.VideoSeconds = 5
			} else {
				callLog.VideoSeconds = 6
			}
		}
	}
	service.EnrichAPICallLog(&callLog, responseBody)
	// Only creation can discover a new video task identity. Polling and result
	// retrieval must not reassign an existing task before its response is checked.
	if call.Capability == "video" && requestKind != "create" && strings.TrimSpace(call.ProviderRequestID) != "" {
		callLog.ProviderRequestID = call.ProviderRequestID
	}
	_ = service.LogAPICall(callLog)
}

func providerRequestErrorDetails(err error) (string, string) {
	if err == nil {
		return "", ""
	}
	if errors.Is(err, context.Canceled) {
		return "request_cancelled", "任务取消，中断上游请求"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "upstream_timeout", "等待上游响应超时"
	}
	return "", safeProviderLogError(err)
}

func safeProviderLogError(err error) string {
	var httpErr providerHTTPError
	if errors.As(err, &httpErr) {
		return fmt.Sprintf("上游 HTTP %d", httpErr.StatusCode)
	}
	return truncateRunes(err.Error(), 500)
}

func providerRequestKind(method string, path string) string {
	if method == http.MethodGet {
		if strings.HasSuffix(strings.TrimRight(path, "/"), "/content") || strings.Contains(path, "/download") {
			return "download"
		}
		return "poll"
	}
	if strings.Contains(path, "repair") {
		return "repair"
	}
	return "create"
}
