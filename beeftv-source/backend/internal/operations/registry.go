package operations

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
)

// Scope 声明操作触及的数据范围：读范围不等于写范围，默认不放大到全工作区批量写。
type Scope string

const (
	ScopeCanvas        Scope = "canvas"
	ScopeConversation  Scope = "conversation"
	ScopeWorkspaceRead Scope = "workspace_read"
)

// Context 是一次操作执行时可用的上下文。Domain 已经绑在当前事务上。
type Context struct {
	OperationID string
	TurnID      string
	Context     context.Context
	UserID      string
	Caller      Caller
	Domain      Domain
}

// Handler 实现一个操作；返回值必须是可 JSON 序列化的业务结果。
type Handler func(ctx *Context, params json.RawMessage) (any, error)

// ReplayProjection 在幂等回放后补上当前投影，不重新执行写入。
type ReplayProjection func(ctx *Context, params json.RawMessage, stored any) (any, error)

// Op 是操作的唯一定义，手工 UI、CLI、MCP 与内置助手都由它派生。
type Op struct {
	ID                string
	Summary           string
	ReadOnly          bool
	Scope             Scope
	Params            json.RawMessage
	Handler           Handler
	ProjectReplay     ReplayProjection
	AssistantCanvas   bool
	AssistantProposal bool
	ReplaySafe        bool
	ReplayUnsafe      bool // A read can still incur an external model charge.
}

// Descriptor 是给客户端做能力发现用的稳定描述。
type Descriptor struct {
	ID             string          `json:"id"`
	Summary        string          `json:"summary"`
	ReadOnly       bool            `json:"readOnly"`
	Scope          Scope           `json:"scope"`
	Params         json.RawMessage `json:"params"`
	AssistantModes []string        `json:"assistantModes"`
	Replay         string          `json:"replay"`
}

// Registry 持有全部操作定义；写操作必须在事务里执行，保证与操作记录同提交。
type Registry struct {
	binder DomainBinder
	store  *Store
	ops    map[string]*Op
}

func NewRegistry(binder DomainBinder, store *Store) *Registry {
	return &Registry{binder: binder, store: store, ops: map[string]*Op{}}
}

func (r *Registry) Register(op Op) {
	if r.ops == nil {
		r.ops = map[string]*Op{}
	}
	copied := op
	r.ops[op.ID] = &copied
}

// List 返回能力发现结果。
// readOnly 为真时只返回只读操作；带助手范围时进一步收窄到该范围真实允许的操作。
func (r *Registry) List(caller Caller) []Descriptor {
	caller = caller.resolved()
	if !caller.knownKind() || caller.assistantWithoutScope() {
		return nil
	}
	out := make([]Descriptor, 0, len(r.ops))
	for _, op := range r.ops {
		if caller.ReadOnly && !op.ReadOnly {
			continue
		}
		if caller.Scope != nil && !caller.Scope.Visible(op) {
			continue
		}
		descriptor := op.Descriptor()
		if caller.assistantSchema() {
			// 内置宿主的幂等键由宿主按「会话身份 + 工具调用 id」生成，模型不该看到也不必
			// 填写 operationId；手工 UI 与外部 MCP/CLI 的 schema 仍然保留它作为稳定幂等键。
			descriptor.Params = op.Params
		}
		out = append(out, descriptor)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (r *Registry) Descriptor(id string) (Descriptor, bool) {
	op, ok := r.ops[id]
	if !ok {
		return Descriptor{}, false
	}
	return op.Descriptor(), true
}

func (op *Op) Descriptor() Descriptor {
	replay := "unsafe"
	if (op.ReadOnly || op.ReplaySafe) && !op.ReplayUnsafe {
		replay = "safe"
	}
	return Descriptor{ID: op.ID, Summary: op.Summary, ReadOnly: op.ReadOnly, Scope: op.Scope, Params: op.writeAwareParams(), AssistantModes: op.assistantModes(), Replay: replay}
}

func (op *Op) assistantModes() []string {
	modes := []string{}
	if op.Scope != ScopeConversation {
		modes = append(modes, "full-access")
	}
	if op.ReadOnly && !op.AssistantProposal {
		modes = append(modes, "read-only")
	}
	if op.AssistantCanvas {
		modes = append(modes, "canvas")
	}
	return modes
}

// AssistantVisible is shared by backend authorization and host capability discovery.
func (op *Op) AssistantVisible(mode string) bool {
	for _, allowed := range op.assistantModes() {
		if allowed == mode {
			return true
		}
	}
	return false
}

func (op *Op) writeAwareParams() json.RawMessage {
	if op.ReadOnly || len(op.Params) == 0 {
		return op.Params
	}
	var schema map[string]any
	if err := json.Unmarshal(op.Params, &schema); err != nil {
		return op.Params
	}
	properties, _ := schema["properties"].(map[string]any)
	if properties == nil {
		properties = map[string]any{}
	}
	properties["operationId"] = map[string]any{
		"type":        "string",
		"description": "调用方生成的稳定幂等键；重试同一操作必须复用同一个值，服务端据此回读原结果",
	}
	schema["properties"] = properties
	required, _ := schema["required"].([]any)
	present := false
	for _, item := range required {
		if name, ok := item.(string); ok && name == "operationId" {
			present = true
		}
	}
	if !present {
		required = append(required, "operationId")
	}
	schema["required"] = required
	encoded, err := json.Marshal(schema)
	if err != nil {
		return op.Params
	}
	return encoded
}

// Execute 执行一个操作：校验能力边界与调用方范围、做持久化幂等，并把业务写入放进事务。
// 授权发生在回放之前：只读客户端、越界助手、缺少身份都不能靠重放拿到别人的结果。
func (r *Registry) Execute(req Request) (Result, error) {
	op, ok := r.ops[strings.TrimSpace(req.Op)]
	if !ok {
		return Result{}, NotFound("unknown_operation", "未知操作: "+req.Op)
	}
	caller := req.resolvedCaller()
	if !caller.knownKind() {
		return Result{}, PermissionDenied("unknown_caller", "未知调用方身份")
	}
	if caller.assistantWithoutScope() {
		return Result{}, PermissionDenied("missing_assistant_scope", "内置助手缺少可信范围，不能执行操作")
	}
	if caller.ReadOnly && !op.ReadOnly {
		return Result{}, newError(CodeReadOnly, "read_only_client", "该客户端为只读模式，不能执行写操作: "+op.ID, nil)
	}
	if strings.TrimSpace(req.UserID) == "" {
		return Result{}, InvalidArg("missing_scope", "缺少用户/工作区作用域")
	}
	params := req.Params
	if len(params) == 0 {
		params = json.RawMessage("{}")
	}
	opID := strings.TrimSpace(req.OpID)
	if !op.ReadOnly {
		schemaParams, schemaOpID, err := splitOperationID(params)
		if err != nil {
			return Result{}, err
		}
		params = schemaParams
		if schemaOpID != "" {
			if opID != "" && opID != schemaOpID {
				return Result{}, InvalidArg("operation_id_conflict",
					"opId 与 params.operationId 不一致；一次调用只能提供一个幂等身份")
			}
			opID = schemaOpID
		}
	}
	if !op.ReadOnly && opID == "" {
		return Result{}, InvalidArg("missing_op_id", "写操作必须提供 opId 作为幂等键")
	}
	if op.ID == "canvas.task.bind" {
		if key := bindEffectKey(params); key == "" {
			return Result{}, InvalidArg("invalid_params", "canvasId、taskId、nodeId 必填")
		} else if opID != key {
			return Result{}, InvalidArg("effect_identity_mismatch", "写操作 opId 必须是 attach-node:任务:节点:输出序号")
		}
	}
	if op.ID == "conversation.message.attach" {
		if key := messageEffectKey(params); key == "" {
			return Result{}, InvalidArg("invalid_params", "conversationId、taskId、messageId 必填")
		} else if opID != key {
			return Result{}, InvalidArg("effect_identity_mismatch", "写操作 opId 必须是 attach-message:任务:消息:输出序号")
		}
	}
	if op.ReadOnly && strings.TrimSpace(req.OpID) != "" {
		return Result{}, InvalidArg("unexpected_op_id", "只读操作不支持 opId")
	}
	if caller.Scope != nil {
		if err := caller.Scope.Allows(op, params); err != nil {
			return Result{}, err
		}
		if op.ID == "canvas.node.bind_asset" {
			// Binding also reads an asset. Authorize before opening the write
			// transaction: project membership uses the shared SQLite connection.
			var asset struct {
				AssetID string `json:"assetId"`
			}
			if err := json.Unmarshal(params, &asset); err != nil {
				return Result{}, InvalidArg("invalid_params", "参数必须是 JSON 对象")
			}
			readParams, _ := json.Marshal(map[string]string{"assetId": asset.AssetID})
			read := assetGetOperation()
			if err := caller.Scope.Allows(&read, readParams); err != nil {
				return Result{}, err
			}
		}
	}
	if op.ReadOnly {
		opID = ""
	}
	runCtx := req.Context
	if runCtx == nil {
		runCtx = context.Background()
	}
	canonicalHash := PayloadHash(op.ID, CanonicalJSON(params))
	rawHash := PayloadHash(op.ID, params)
	alternateHash := ""
	if rawHash != canonicalHash {
		alternateHash = rawHash
	}
	var target struct {
		CanvasID string `json:"canvasId"`
	}
	if !op.ReadOnly && strings.TrimSpace(req.TurnID) != "" {
		if err := json.Unmarshal(params, &target); err != nil || strings.TrimSpace(target.CanvasID) == "" {
			return Result{}, InvalidArg("missing_turn_canvas", "助手写入必须指定当前画布")
		}
	}
	outcome, err := r.store.RunDomain(runCtx, RunRequest{UserID: req.UserID, OpID: opID, Op: op.ID,
		PayloadHash: canonicalHash, AlternatePayloadHash: alternateHash, TurnID: req.TurnID, CanvasID: target.CanvasID}, r.binder, func(domain Domain) ([]byte, error) {
		execCtx := &Context{Context: runCtx, UserID: req.UserID, Caller: caller, Domain: domain, OperationID: opID, TurnID: req.TurnID}
		value, runErr := op.Handler(execCtx, params)
		if runErr != nil {
			return nil, AsError(runErr)
		}
		encoded, encErr := json.Marshal(value)
		if encErr != nil {
			return nil, AsError(encErr)
		}
		return encoded, nil
	})
	if err != nil {
		return Result{}, err
	}
	var decoded any
	if len(outcome.Result) > 0 {
		if err := json.Unmarshal(outcome.Result, &decoded); err != nil {
			return Result{}, AsError(err)
		}
	}
	if outcome.Replayed && op.ProjectReplay != nil {
		projected, projErr := r.store.RunDomain(runCtx, RunRequest{UserID: req.UserID}, r.binder, func(domain Domain) ([]byte, error) {
			value, replayErr := op.ProjectReplay(&Context{Context: runCtx, UserID: req.UserID, Caller: caller, Domain: domain}, params, decoded)
			if replayErr != nil {
				return nil, replayErr
			}
			encoded, encErr := json.Marshal(value)
			if encErr != nil {
				return nil, AsError(encErr)
			}
			return encoded, nil
		})
		if projErr != nil {
			return Result{}, projErr
		}
		if len(projected.Result) > 0 {
			if err := json.Unmarshal(projected.Result, &decoded); err != nil {
				return Result{}, AsError(err)
			}
		}
	}
	return Result{
		Op:       op.ID,
		OpID:     opID,
		Replayed: outcome.Replayed,
		Result:   decoded,
		Revision: revisionFromResult(decoded),
		Caller:   caller.Kind,
	}, nil
}

func splitOperationID(params json.RawMessage) (json.RawMessage, string, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(params, &object); err != nil {
		return params, "", nil
	}
	raw, found := object["operationId"]
	if !found {
		return params, "", nil
	}
	delete(object, "operationId")
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return params, "", InvalidArg("invalid_params", "operationId 必须是字符串")
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		return params, strings.TrimSpace(value), nil
	}
	return encoded, strings.TrimSpace(value), nil
}
