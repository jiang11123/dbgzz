package repository

import (
	"errors"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestDeletePluginStatesRemovesUserAndPlatform(t *testing.T) {
	r := newPluginStateRepo(t)
	now := time.Now()
	if err := r.SavePluginPlatformState(&model.PluginPlatformState{PluginID: "ok-plugin", Available: true, UpdatedBy: "admin", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := r.SaveUserPluginState(&model.UserPluginState{ID: "user-state-ok", UserID: "user-1", PluginID: "ok-plugin", Enabled: true, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := r.DeletePluginStates("ok-plugin"); err != nil {
		t.Fatal(err)
	}
	user, err := r.UserPluginState("user-1", "ok-plugin")
	if err != nil || user != nil {
		t.Fatalf("user state = %#v err=%v", user, err)
	}
	platform, err := r.PluginPlatformState("ok-plugin")
	if err != nil || platform != nil {
		t.Fatalf("platform state = %#v err=%v", platform, err)
	}
}

func TestDeletePluginStatesRollsBackWhenPlatformDeleteFails(t *testing.T) {
	r := newPluginStateRepo(t)
	now := time.Now()
	if err := r.SavePluginPlatformState(&model.PluginPlatformState{PluginID: "tx-plugin", Available: true, UpdatedBy: "admin", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := r.SaveUserPluginState(&model.UserPluginState{ID: "user-state-tx", UserID: "user-1", PluginID: "tx-plugin", Enabled: true, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := r.db.Callback().Delete().Before("gorm:delete").Register("test_fail_platform_delete", func(tx *gorm.DB) {
		table := ""
		if tx.Statement != nil {
			table = tx.Statement.Table
		}
		if strings.Contains(strings.ToLower(table), "plugin_platform") {
			_ = tx.AddError(errors.New("forced platform delete failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = r.db.Callback().Delete().Remove("test_fail_platform_delete")
	})
	if err := r.DeletePluginStates("tx-plugin"); err == nil || !strings.Contains(err.Error(), "forced platform delete failure") {
		t.Fatalf("delete error = %v", err)
	}
	user, err := r.UserPluginState("user-1", "tx-plugin")
	if err != nil || user == nil {
		t.Fatalf("user state missing after rollback: %#v err=%v", user, err)
	}
	platform, err := r.PluginPlatformState("tx-plugin")
	if err != nil || platform == nil {
		t.Fatalf("platform state missing after rollback: %#v err=%v", platform, err)
	}
}

func TestCommitPluginRegistryPersistsSettingAndPlatform(t *testing.T) {
	r := newPluginStateRepo(t)
	now := time.Now()
	if err := r.CommitPluginRegistry("plugin_registry", `[{"id":"ok-plugin"}]`, &model.PluginPlatformState{PluginID: "ok-plugin", Available: true, UpdatedBy: "admin", CreatedAt: now, UpdatedAt: now}, ""); err != nil {
		t.Fatal(err)
	}
	setting, err := r.LookupSystemSetting("plugin_registry")
	if err != nil || setting == nil || setting.ValueJSON != `[{"id":"ok-plugin"}]` {
		t.Fatalf("registry setting = %#v err=%v", setting, err)
	}
	platform, err := r.PluginPlatformState("ok-plugin")
	if err != nil || platform == nil || !platform.Available {
		t.Fatalf("platform = %#v err=%v", platform, err)
	}
}

func TestCommitPluginRegistryRollsBackWhenPlatformSaveFails(t *testing.T) {
	r := newPluginStateRepo(t)
	now := time.Now()
	if err := r.CommitPluginRegistry("plugin_registry", `[{"id":"before"}]`, nil, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.db.Callback().Create().Before("gorm:create").Register("test_fail_platform_create", func(tx *gorm.DB) {
		table := ""
		if tx.Statement != nil {
			table = tx.Statement.Table
		}
		if strings.Contains(strings.ToLower(table), "plugin_platform") {
			_ = tx.AddError(errors.New("forced platform save failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = r.db.Callback().Create().Remove("test_fail_platform_create")
	})
	err := r.CommitPluginRegistry("plugin_registry", `[{"id":"after"}]`, &model.PluginPlatformState{PluginID: "after", Available: true, UpdatedBy: "admin", CreatedAt: now, UpdatedAt: now}, "")
	if err == nil || !strings.Contains(err.Error(), "forced platform save failure") {
		t.Fatalf("commit error = %v", err)
	}
	setting, err := r.LookupSystemSetting("plugin_registry")
	if err != nil || setting == nil || setting.ValueJSON != `[{"id":"before"}]` {
		t.Fatalf("registry rolled back = %#v err=%v", setting, err)
	}
	platform, err := r.PluginPlatformState("after")
	if err != nil || platform != nil {
		t.Fatalf("platform leaked = %#v err=%v", platform, err)
	}
}

func TestCommitPluginRegistryDeletesStatesWithRegistry(t *testing.T) {
	r := newPluginStateRepo(t)
	now := time.Now()
	if err := r.CommitPluginRegistry("plugin_registry", `[{"id":"gone"}]`, &model.PluginPlatformState{PluginID: "gone", Available: true, UpdatedBy: "admin", CreatedAt: now, UpdatedAt: now}, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.SaveUserPluginState(&model.UserPluginState{ID: "user-state-gone", UserID: "user-1", PluginID: "gone", Enabled: true, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := r.CommitPluginRegistry("plugin_registry", `[]`, nil, "gone"); err != nil {
		t.Fatal(err)
	}
	setting, err := r.LookupSystemSetting("plugin_registry")
	if err != nil || setting == nil || setting.ValueJSON != `[]` {
		t.Fatalf("registry after delete = %#v err=%v", setting, err)
	}
	user, err := r.UserPluginState("user-1", "gone")
	if err != nil || user != nil {
		t.Fatalf("user state = %#v err=%v", user, err)
	}
	platform, err := r.PluginPlatformState("gone")
	if err != nil || platform != nil {
		t.Fatalf("platform state = %#v err=%v", platform, err)
	}
}

func newPluginStateRepo(t *testing.T) *Repository {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:plugin-states-"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.PluginPlatformState{}, &model.UserPluginState{}); err != nil {
		t.Fatal(err)
	}
	return New(db)
}
