package agentops

import "infinite-canvas/backend/internal/operations"

type (
	Code  = operations.Code
	Error = operations.Error
)

const (
	CodeInvalidArgument    = operations.CodeInvalidArgument
	CodeNotFound           = operations.CodeNotFound
	CodeConflict           = operations.CodeConflict
	CodePreconditionFailed = operations.CodePreconditionFailed
	CodeReadOnly           = operations.CodeReadOnly
	CodePermissionDenied   = operations.CodePermissionDenied
	CodeUnsupported        = operations.CodeUnsupported
	CodeInternal           = operations.CodeInternal
)

func InvalidArg(reason, message string) *Error { return operations.InvalidArg(reason, message) }

func NotFound(reason, message string) *Error { return operations.NotFound(reason, message) }

func Conflict(reason, message string, details map[string]any) *Error {
	return operations.Conflict(reason, message, details)
}

func PreconditionFailed(reason, message string, details map[string]any) *Error {
	return operations.PreconditionFailed(reason, message, details)
}

func Unsupported(reason, message string) *Error { return operations.Unsupported(reason, message) }

func AsError(err error) *Error { return operations.AsError(err) }

func HTTPStatus(code Code) int { return operations.HTTPStatus(code) }
