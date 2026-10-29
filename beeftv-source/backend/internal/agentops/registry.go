package agentops

import "infinite-canvas/backend/internal/operations"

type (
	Scope      = operations.Scope
	Context    = operations.Context
	Handler    = operations.Handler
	Op         = operations.Op
	Descriptor = operations.Descriptor
	Caller     = operations.Caller
	CallerKind = operations.CallerKind
	Request    = operations.Request
	Result     = operations.Result
	Receipt    = operations.Receipt
	Registry   = operations.Registry
)

const (
	ScopeCanvas        = operations.ScopeCanvas
	ScopeWorkspaceRead = operations.ScopeWorkspaceRead
	CallerManual       = operations.CallerManual
	CallerAssistant    = operations.CallerAssistant
	CallerExternal     = operations.CallerExternal
)

func NewRegistry(binder operations.DomainBinder, store *Store) *Registry {
	return operations.NewRegistry(binder, store)
}

func RegisterDefaultOps(r *Registry) { operations.RegisterDefaultOps(r) }

func ManualCaller(readOnly bool) Caller { return operations.ManualCaller(readOnly) }

func AssistantCaller(scope *AssistantScope, readOnly bool) Caller {
	return operations.AssistantCaller(scope, readOnly)
}

func ExternalCaller(readOnly bool) Caller { return operations.ExternalCaller(readOnly) }
