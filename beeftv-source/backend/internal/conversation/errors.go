package conversation

import (
	"net/http"
	"strings"
)

const (
	ReasonNotFound            = "not_found"
	ReasonConflict            = "conflict"
	ReasonStaleRevision       = "stale_revision"
	ReasonDeleted             = "conversation_deleted"
	ReasonMessageTaskMismatch = "message_task_mismatch"
	ReasonInvalid             = "invalid_argument"
	ReasonUnavailable         = "unavailable"
)

// Error is the domain HTTP projection. Handlers map Status/Reason; this
// package does not import app.
type Error struct {
	Status  int
	Reason  string
	Message string
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if strings.TrimSpace(e.Message) != "" {
		return e.Message
	}
	return e.Reason
}

func errNotFound() *Error {
	return &Error{Status: http.StatusNotFound, Reason: ReasonNotFound, Message: "创作对话不存在"}
}

func errConflict() *Error {
	return &Error{Status: http.StatusConflict, Reason: ReasonConflict, Message: "对话已更新，当前草稿未覆盖已保存内容"}
}

func errDeleted() *Error {
	return &Error{Status: http.StatusConflict, Reason: ReasonDeleted, Message: "对话已删除，无法再写入"}
}

func errMessageTaskMismatch() *Error {
	return &Error{Status: http.StatusConflict, Reason: ReasonMessageTaskMismatch, Message: "这条消息已经换了任务，不能再写入这次结果"}
}

func errInvalid(message string) *Error {
	if strings.TrimSpace(message) == "" {
		message = "创作对话内容无效"
	}
	return &Error{Status: http.StatusBadRequest, Reason: ReasonInvalid, Message: message}
}

func errIdentity() *Error {
	return &Error{Status: http.StatusBadRequest, Reason: ReasonInvalid, Message: "缺少工作区身份"}
}

func errUnavailable() *Error {
	return &Error{Status: http.StatusServiceUnavailable, Reason: ReasonUnavailable, Message: "创作对话存储不可用"}
}

func ErrUnavailable() *Error {
	return errUnavailable()
}
