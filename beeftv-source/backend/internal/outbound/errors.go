package outbound

// DNSResolutionError keeps the resolver cause for retry classification only.
// Error must not expose the hostname, DNS server, or a caller's signed URL.
type DNSResolutionError struct{ Cause error }

func (e *DNSResolutionError) Error() string { return "外部服务域名解析失败" }
func (e *DNSResolutionError) Unwrap() error { return e.Cause }

// BadRequestError 是出站校验失败（URL/Header 等）的稳定错误类型。
// service 层通过 aliases 转成 AppError，避免 outbound → service 回环。
type BadRequestError struct {
	Message string
}

func (e *BadRequestError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func BadAuthRequest(message string) error {
	return &BadRequestError{Message: message}
}

// HTTPStatusError preserves response classification without storing bodies or URLs.
type HTTPStatusError struct {
	StatusCode int
	Message    string
}

func (e *HTTPStatusError) Error() string   { return e.Message }
func (e *HTTPStatusError) Temporary() bool { return retryableHTTPStatus(e.StatusCode) }
