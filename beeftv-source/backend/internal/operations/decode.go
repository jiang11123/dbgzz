package operations

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/conversation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/taskbinding"
)

func decodeParams(params json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(params))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) {
			return InvalidArg("invalid_params", "参数类型不正确: 字段 "+typeErr.Field)
		}
		if field, ok := unknownField(err); ok {
			return newError(CodeInvalidArgument, "unknown_field", "参数包含未知字段: "+field,
				map[string]any{"field": field})
		}
		return InvalidArg("invalid_params", err.Error())
	}
	if err := decoder.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return InvalidArg("invalid_params", "参数包含多余内容")
	}
	return nil
}

func unknownField(err error) (string, bool) {
	const prefix = `json: unknown field `
	message := err.Error()
	if !strings.HasPrefix(message, prefix) {
		return "", false
	}
	name := strings.Trim(strings.TrimPrefix(message, prefix), `"`)
	if name == "" {
		return "", false
	}
	return name, true
}

var secretKeyPattern = regexp.MustCompile(`(?i)(api[_-]?key|secret|token|authorization|password|credential|private[_-]?key)`)

func sanitizeForClient(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			if secretKeyPattern.MatchString(key) {
				out[key] = "[redacted]"
				continue
			}
			out[key] = sanitizeForClient(item)
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, sanitizeForClient(item))
		}
		return out
	case string:
		if strings.Contains(typed, "?") && secretKeyPattern.MatchString(typed) {
			if idx := strings.Index(typed, "?"); idx > 0 {
				return typed[:idx]
			}
		}
		return typed
	default:
		return value
	}
}

func mapDomainError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return NotFound("not_found", "资源不存在")
	}
	var bindErr *taskbinding.Error
	if errors.As(err, &bindErr) {
		return mapBindError(bindErr.Status, bindErr.Reason, bindErr.Message)
	}
	var convErr *conversation.Error
	if errors.As(err, &convErr) {
		return mapBindError(convErr.Status, convErr.Reason, convErr.Message)
	}
	var appErr *kernel.AppError
	if errors.As(err, &appErr) {
		reason := string(appErr.Reason)
		switch appErr.Status {
		case http.StatusNotFound:
			if reason == "" || reason == string(kernel.ReasonNotFound) {
				reason = "not_found"
			}
			return NotFound(reason, appErr.Message)
		case http.StatusConflict:
			if reason == "" || reason == string(kernel.ReasonConflict) {
				reason = "stale_revision"
			}
			return Conflict(reason, appErr.Message, nil)
		case http.StatusPreconditionFailed:
			if reason == "" {
				reason = "precondition_failed"
			}
			return PreconditionFailed(reason, appErr.Message, nil)
		case http.StatusForbidden:
			if reason == "" {
				reason = "permission_denied"
			}
			return PermissionDenied(reason, appErr.Message)
		case http.StatusBadRequest:
			if appErr.Reason == kernel.ReasonUnsupportedField {
				return InvalidArg(string(kernel.ReasonUnsupportedField), appErr.Message)
			}
			if reason == "" {
				reason = "invalid_request"
			}
			return InvalidArg(reason, appErr.Message)
		}
	}
	var conflicter interface{ IsConflict() bool }
	if errors.As(err, &conflicter) && conflicter.IsConflict() {
		return Conflict("stale_write", "写入冲突，已停止覆盖", nil)
	}
	return AsError(err)
}

func isNotFoundError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return true
	}
	var bindErr *taskbinding.Error
	if errors.As(err, &bindErr) && bindErr.Status == http.StatusNotFound {
		return true
	}
	var convErr *conversation.Error
	if errors.As(err, &convErr) && convErr.Status == http.StatusNotFound {
		return true
	}
	var appErr *kernel.AppError
	if errors.As(err, &appErr) && appErr.Status == http.StatusNotFound {
		return true
	}
	var opErr *Error
	if errors.As(err, &opErr) && opErr.Code == CodeNotFound {
		return true
	}
	return false
}

func mapBindError(status int, reason, message string) error {
	if reason == "" {
		reason = "bind_failed"
	}
	switch status {
	case http.StatusNotFound:
		return NotFound(reason, message)
	case http.StatusConflict:
		return Conflict(reason, message, nil)
	case http.StatusPreconditionFailed:
		return PreconditionFailed(reason, message, nil)
	case http.StatusForbidden:
		return PermissionDenied(reason, message)
	case http.StatusBadRequest:
		return InvalidArg(reason, message)
	default:
		return newError(CodeInternal, reason, message, nil)
	}
}
