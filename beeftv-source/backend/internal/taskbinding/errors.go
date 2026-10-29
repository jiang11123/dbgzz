package taskbinding

import "net/http"

// Error is a domain bind failure. operations maps it; this package does not
// import operations or app.
type Error struct {
	Status  int
	Reason  string
	Message string
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func invalid(reason, message string) *Error {
	return &Error{Status: http.StatusBadRequest, Reason: reason, Message: message}
}

func notFound(reason, message string) *Error {
	return &Error{Status: http.StatusNotFound, Reason: reason, Message: message}
}

func conflict(reason, message string) *Error {
	return &Error{Status: http.StatusConflict, Reason: reason, Message: message}
}

func precondition(reason, message string) *Error {
	return &Error{Status: http.StatusPreconditionFailed, Reason: reason, Message: message}
}

func forbidden(reason, message string) *Error {
	return &Error{Status: http.StatusForbidden, Reason: reason, Message: forbiddenMessage(message)}
}

func forbiddenMessage(message string) string {
	if message == "" {
		return "无权绑定该任务结果"
	}
	return message
}
