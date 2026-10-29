// Package operations 是产品中立的工作区操作层：注册表、调用方身份、幂等 operationId、
// revision 与事务回执。手工 UI、内置助手与外部 CLI/MCP 共用这一套，不各自实现写入。
package operations

import (
	"errors"
	"fmt"
	"net/http"
)

// Code 是机器可读的错误类型，客户端按它判断分支，不解析文案。
type Code string

const (
	CodeInvalidArgument    Code = "invalid_argument"
	CodeNotFound           Code = "not_found"
	CodeConflict           Code = "conflict"
	CodePreconditionFailed Code = "precondition_failed"
	CodeReadOnly           Code = "read_only"
	CodePermissionDenied   Code = "permission_denied"
	CodeUnsupported        Code = "unsupported"
	CodeInternal           Code = "internal"
)

// Error 是操作层统一的结构化错误。
type Error struct {
	Code    Code           `json:"code"`
	Message string         `json:"message"`
	Reason  string         `json:"reason,omitempty"`
	Details map[string]any `json:"details,omitempty"`
	cause   error
}

func (e *Error) Error() string {
	if e.Reason != "" {
		return fmt.Sprintf("%s: %s (%s)", e.Code, e.Message, e.Reason)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

func newError(code Code, reason, message string, details map[string]any) *Error {
	return &Error{Code: code, Message: message, Reason: reason, Details: details}
}

func InvalidArg(reason, message string) *Error {
	return newError(CodeInvalidArgument, reason, message, nil)
}

func NotFound(reason, message string) *Error { return newError(CodeNotFound, reason, message, nil) }

func Conflict(reason, message string, details map[string]any) *Error {
	return newError(CodeConflict, reason, message, details)
}

func PreconditionFailed(reason, message string, details map[string]any) *Error {
	return newError(CodePreconditionFailed, reason, message, details)
}

func Unsupported(reason, message string) *Error {
	return newError(CodeUnsupported, reason, message, nil)
}

func PermissionDenied(reason, message string) *Error {
	return newError(CodePermissionDenied, reason, message, nil)
}

// AsError 把任意错误规整成操作层错误；未识别的错误一律 internal，不泄露内部细节。
func AsError(err error) *Error {
	if err == nil {
		return nil
	}
	var opErr *Error
	if errors.As(err, &opErr) {
		return opErr
	}
	wrapped := newError(CodeInternal, "operation_failed", err.Error(), nil)
	wrapped.cause = err
	return wrapped
}

// HTTPStatus 把操作错误映射到真实 HTTP 状态，不把失败包装成 200。
func HTTPStatus(code Code) int {
	switch code {
	case CodeInvalidArgument:
		return http.StatusBadRequest
	case CodeNotFound:
		return http.StatusNotFound
	case CodeConflict:
		return http.StatusConflict
	case CodePreconditionFailed:
		return http.StatusPreconditionFailed
	case CodeReadOnly, CodeUnsupported:
		return http.StatusForbidden
	case CodePermissionDenied:
		return http.StatusForbidden
	default:
		return http.StatusInternalServerError
	}
}
