package generation

import (
	"context"
	"strings"
)

type runtimeKey struct{}

func WithRuntime(ctx context.Context, runtime Runtime) context.Context {
	return context.WithValue(ctx, runtimeKey{}, runtime)
}

func RuntimeFromContext(ctx context.Context) (Runtime, bool) {
	if ctx == nil {
		return Runtime{}, false
	}
	runtime, ok := ctx.Value(runtimeKey{}).(Runtime)
	return runtime, ok
}

func WithCallMeta(ctx context.Context, meta CallMeta) context.Context {
	runtime, _ := RuntimeFromContext(ctx)
	runtime.Call = meta
	return WithRuntime(ctx, runtime)
}

// EnrichCallMeta copies only identity/resume fields onto the current Call.
// Route, model, trace, capability, and videoSeconds stay as they are.
func EnrichCallMeta(ctx context.Context, patch CallMeta) context.Context {
	runtime, _ := RuntimeFromContext(ctx)
	runtime.Call = enrichCallMeta(runtime.Call, patch)
	return WithRuntime(ctx, runtime)
}

func IdentityCallMeta(base, patch CallMeta) CallMeta {
	return enrichCallMeta(base, patch)
}

func enrichCallMeta(base, patch CallMeta) CallMeta {
	if value := strings.TrimSpace(patch.UserID); value != "" {
		base.UserID = value
	}
	if value := strings.TrimSpace(patch.TaskID); value != "" {
		base.TaskID = value
	}
	if value := strings.TrimSpace(patch.ProjectID); value != "" {
		base.ProjectID = value
	}
	if value := strings.TrimSpace(patch.TaskType); value != "" {
		base.TaskType = value
	}
	if value := strings.TrimSpace(patch.RequestKind); value != "" {
		base.RequestKind = value
	}
	if value := strings.TrimSpace(patch.ProviderRequestID); value != "" {
		base.ProviderRequestID = value
	}
	return base
}

func WithEndpoints(ctx context.Context, endpoints Endpoints) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	runtime, _ := RuntimeFromContext(ctx)
	runtime.Endpoints = endpoints
	return WithRuntime(ctx, runtime)
}

func CallMetaFromContext(ctx context.Context) (CallMeta, bool) {
	runtime, ok := RuntimeFromContext(ctx)
	if !ok {
		return CallMeta{}, false
	}
	return runtime.Call, true
}

func WithRequestKind(ctx context.Context, requestKind string) context.Context {
	runtime, ok := RuntimeFromContext(ctx)
	if !ok {
		return ctx
	}
	runtime.Call.RequestKind = requestKind
	return WithRuntime(ctx, runtime)
}

func ResumedProviderRequestID(ctx context.Context) string {
	meta, _ := CallMetaFromContext(ctx)
	return strings.TrimSpace(meta.ProviderRequestID)
}

func TaskExecutionID(ctx context.Context) string {
	meta, _ := CallMetaFromContext(ctx)
	return strings.TrimSpace(meta.TaskID)
}

func WithTaskExecutionID(ctx context.Context, taskID string) context.Context {
	runtime, _ := RuntimeFromContext(ctx)
	runtime.Call.TaskID = strings.TrimSpace(taskID)
	return WithRuntime(ctx, runtime)
}

// WithoutCallAccounting drops circuit, slot, and receipt accounting so nested
// control-plane calls do not inherit the parent generation request's channel.
func WithoutCallAccounting(ctx context.Context) context.Context {
	runtime, ok := RuntimeFromContext(ctx)
	if !ok {
		return ctx
	}
	runtime.Limits = nil
	runtime.Receipts = nil
	runtime.Call = CallMeta{UserID: runtime.Call.UserID, TaskID: runtime.Call.TaskID}
	return WithRuntime(ctx, runtime)
}
