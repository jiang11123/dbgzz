package operations

import (
	"context"
	"encoding/json"
	"reflect"
)

// CallerKind 是一次操作的调用方身份。同一套操作对三种入口都有效：
// 手工 UI（owner/桌面）、内置助手、外部 CLI/MCP。
type CallerKind string

const (
	CallerManual    CallerKind = "manual"
	CallerAssistant CallerKind = "assistant"
	CallerExternal  CallerKind = "external"
)

// Authorizer 是调用方范围裁决。操作核不知道画布/素材规则，只在回放之前调用它。
type Authorizer interface {
	Allows(op *Op, params json.RawMessage) error
	Visible(op *Op) bool
}

// Caller 是一次调用的能力身份。
type Caller struct {
	Kind     CallerKind
	ReadOnly bool
	Scope    Authorizer
}

func ManualCaller(readOnly bool) Caller {
	return Caller{Kind: CallerManual, ReadOnly: readOnly}
}

func AssistantCaller(scope Authorizer, readOnly bool) Caller {
	return Caller{Kind: CallerAssistant, ReadOnly: readOnly, Scope: scope}
}

func ExternalCaller(readOnly bool) Caller {
	return Caller{Kind: CallerExternal, ReadOnly: readOnly}
}

func (c Caller) resolved() Caller {
	c.Scope = liveAuthorizer(c.Scope)
	if c.Kind != "" {
		return c
	}
	if c.Scope != nil {
		c.Kind = CallerAssistant
		return c
	}
	c.Kind = CallerManual
	return c
}

func (c Caller) knownKind() bool {
	switch c.Kind {
	case CallerManual, CallerAssistant, CallerExternal:
		return true
	default:
		return false
	}
}

func (c Caller) assistantWithoutScope() bool {
	return c.Kind == CallerAssistant && c.Scope == nil
}

// liveAuthorizer 丢掉「带类型的空指针」：把 *T(nil) 赋给 Authorizer 时接口本身非空，
// List/Execute 会误当成已设置助手范围，owner/CLI/MCP 的能力发现会被收成 7 项。
func liveAuthorizer(scope Authorizer) Authorizer {
	if scope == nil {
		return nil
	}
	value := reflect.ValueOf(scope)
	switch value.Kind() {
	case reflect.Ptr, reflect.Interface, reflect.Map, reflect.Slice, reflect.Func, reflect.Chan:
		if value.IsNil() {
			return nil
		}
	}
	return scope
}

func (c Caller) assistantSchema() bool {
	return c.resolved().Kind == CallerAssistant
}

// Request 是一次操作调用的入参。
type Request struct {
	Context context.Context
	OpID    string
	Op      string
	UserID  string
	Caller  Caller
	// ReadOnly 是 Caller.ReadOnly 的便捷字段；现有调用方只填它时仍然有效。
	ReadOnly bool
	Params   json.RawMessage
	// TurnID 是写入发生时所属的助手回合；只有内置助手宿主会提供，其他入口留空。
	TurnID string
}

func (r Request) resolvedCaller() Caller {
	caller := r.Caller
	if r.ReadOnly {
		caller.ReadOnly = true
	}
	return caller.resolved()
}

// Result 是操作结果信封。Replayed 表示命中了操作 ID 去重、回读了原结果。
// Revision 从写结果里提升到信封，方便手工 UI 做 CAS，不要求调用方再拆 payload。
type Result struct {
	Op       string     `json:"op"`
	OpID     string     `json:"opId,omitempty"`
	Replayed bool       `json:"replayed"`
	Result   any        `json:"result"`
	Revision int64      `json:"revision,omitempty"`
	Caller   CallerKind `json:"caller,omitempty"`
}

// Receipt 是给手工 UI / 助手结算用的回执视图。存储层仍写既有 agent_op_records 表，不另起一份。
type Receipt struct {
	OperationID string     `json:"operationId,omitempty"`
	Op          string     `json:"op"`
	Replayed    bool       `json:"replayed"`
	Revision    int64      `json:"revision,omitempty"`
	Caller      CallerKind `json:"caller,omitempty"`
	TurnID      string     `json:"turnId,omitempty"`
	Result      any        `json:"result"`
}

func (r Result) Receipt(turnID string) Receipt {
	return Receipt{
		OperationID: r.OpID,
		Op:          r.Op,
		Replayed:    r.Replayed,
		Revision:    r.Revision,
		Caller:      r.Caller,
		TurnID:      turnID,
		Result:      r.Result,
	}
}

func revisionFromResult(value any) int64 {
	object, ok := value.(map[string]any)
	if !ok {
		return 0
	}
	switch typed := object["revision"].(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	case int:
		return int64(typed)
	case json.Number:
		n, err := typed.Int64()
		if err != nil {
			return 0
		}
		return n
	default:
		return 0
	}
}
