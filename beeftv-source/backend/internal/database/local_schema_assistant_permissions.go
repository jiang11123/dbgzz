package database

import (
	"fmt"
	"gorm.io/gorm"
)

func migrateAssistantPermissions(tx *gorm.DB) error {
	for _, name := range []string{"permission_mode", "canvas_snapshots_json"} {
		if err := ensureSQLiteColumn(tx, "assistant_turns", name, "TEXT"); err != nil {
			return err
		}
	}
	return requireAssistantPermissions(tx)
}
func requireAssistantPermissions(db *gorm.DB) error {
	for _, name := range []string{"permission_mode", "canvas_snapshots_json"} {
		has, err := sqliteHasColumn(db, "assistant_turns", name)
		if err != nil {
			return err
		}
		if !has {
			return fmt.Errorf("助手权限和撤销记录缺少 %s，请启用自动迁移", name)
		}
	}
	return nil
}
