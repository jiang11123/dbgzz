package assistantruntime

import "fmt"

// hostError 保持原先 handler 通过 agentops.InvalidArg 暴露的 Error() 文本，
// 避免 HTTP msg 与既有调用方比较字符串时发生变化。
type hostError struct {
	code    string
	reason  string
	message string
}

func invalidArg(reason, message string) error {
	return &hostError{code: "invalid_argument", reason: reason, message: message}
}

func (e *hostError) Error() string {
	if e == nil {
		return ""
	}
	if e.reason != "" {
		return fmt.Sprintf("%s: %s (%s)", e.code, e.message, e.reason)
	}
	return fmt.Sprintf("%s: %s", e.code, e.message)
}

func (e *hostError) Reason() string {
	if e == nil {
		return ""
	}
	return e.reason
}
