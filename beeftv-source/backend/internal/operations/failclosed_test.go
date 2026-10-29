package operations

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/database"
)

func TestNilStoreFailsClosedWithoutPanic(t *testing.T) {
	fn := func(tx *gorm.DB) ([]byte, error) {
		t.Fatal("不可用的 store 不得执行业务")
		return nil, nil
	}
	for _, store := range []*Store{nil, NewStore(nil)} {
		if store.Available() {
			t.Fatal("空 store 必须不可用")
		}
		if _, err := store.Run(context.Background(), RunRequest{Op: "canvas.get"}, fn); err == nil {
			t.Fatal("只读路径也必须失败关闭")
		} else if AsError(err).Reason != "op_store_unavailable" {
			t.Fatalf("只读失败原因: %v", err)
		}
		if _, err := store.Run(context.Background(), RunRequest{OpID: "op-1", Op: "canvas.nodes.create"}, fn); err == nil {
			t.Fatal("写路径必须失败关闭")
		} else if AsError(err).Reason != "op_store_unavailable" {
			t.Fatalf("写失败原因: %v", err)
		}
	}
}

type nilDomainBinder struct{}

func (nilDomainBinder) BindDomain(*gorm.DB) Domain { return nil }

func TestMissingDomainBinderFailsClosed(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "failclosed.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	store := NewStore(db)
	fn := func(domain Domain) ([]byte, error) {
		t.Fatal("缺少 Domain 不得执行 handler")
		return nil, nil
	}
	if _, err := store.RunDomain(context.Background(), RunRequest{Op: "canvas.get"}, nil, fn); err == nil {
		t.Fatal("nil binder 必须失败")
	} else if AsError(err).Reason != "op_domain_unavailable" {
		t.Fatalf("nil binder 原因: %v", err)
	}
	if _, err := store.RunDomain(context.Background(), RunRequest{Op: "canvas.get"}, nilDomainBinder{}, fn); err == nil {
		t.Fatal("BindDomain 返回 nil 必须失败")
	} else if AsError(err).Reason != "op_domain_unavailable" {
		t.Fatalf("nil domain 原因: %v", err)
	}
}

func TestAssistantWithoutScopeFailsClosed(t *testing.T) {
	registry := NewRegistry(nil, nil)
	RegisterDefaultOps(registry)
	listed := registry.List(AssistantCaller(nil, false))
	if len(listed) != 0 {
		t.Fatalf("助手缺少范围时能力发现必须为空，得到 %v", descriptorIDs(listed))
	}
	var typedNil *filterGetOnly
	listed = registry.List(Caller{Kind: CallerAssistant, Scope: typedNil})
	if len(listed) != 0 {
		t.Fatalf("助手带类型空范围不得回退成手工能力: %v", descriptorIDs(listed))
	}
	_, err := registry.Execute(Request{
		Op: "canvas.get", UserID: "local", Caller: AssistantCaller(nil, false),
		Params: json.RawMessage(`{"canvasId":"c"}`),
	})
	if err == nil {
		t.Fatal("助手缺少范围时执行必须拒绝")
	}
	if got := AsError(err); got.Code != CodePermissionDenied || got.Reason != "missing_assistant_scope" {
		t.Fatalf("缺少范围拒绝原因: %v", err)
	}
}

func TestUnknownCallerKindFailsClosed(t *testing.T) {
	registry := NewRegistry(nil, nil)
	RegisterDefaultOps(registry)
	unknown := Caller{Kind: "forged"}
	if len(registry.List(unknown)) != 0 {
		t.Fatal("未知身份不得发现操作")
	}
	_, err := registry.Execute(Request{
		Op: "canvas.get", UserID: "local", Caller: unknown,
		Params: json.RawMessage(`{"canvasId":"c"}`),
	})
	if got := AsError(err); got.Code != CodePermissionDenied || got.Reason != "unknown_caller" {
		t.Fatalf("未知身份执行原因: %v", err)
	}
}

func TestEmptyAssistantScopeStillDiscoversRestrictedSet(t *testing.T) {
	registry := NewRegistry(nil, nil)
	RegisterDefaultOps(registry)
	listed := registry.List(AssistantCaller(&filterGetOnly{}, false))
	if len(listed) != 1 || listed[0].ID != "canvas.get" {
		t.Fatalf("显式空适配器应按 Visible 收窄: %v", descriptorIDs(listed))
	}
}
