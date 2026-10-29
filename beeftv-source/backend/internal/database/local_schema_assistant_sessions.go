package database

import (
	"fmt"
	"gorm.io/gorm"
)

func migrateAssistantSessions(tx *gorm.DB) error {
	for _, name := range []string{"durable_session_id", "durable_native_sources"} {
		if err := ensureSQLiteColumn(tx, "assistant_turns", name, "TEXT"); err != nil {
			return err
		}
	}
	return requireAssistantSessions(tx)
}
func requireAssistantSessions(db *gorm.DB) error {
	has, err := sqliteHasColumn(db, "assistant_turns", "durable_session_id")
	if err != nil {
		return err
	}
	if !has {
		return fmt.Errorf("助手会话绑定缺失，请启用自动迁移")
	}
	has, err = sqliteHasColumn(db, "assistant_turns", "durable_native_sources")
	if err != nil {
		return err
	}
	if !has {
		return fmt.Errorf("助手历史素材授权缺失，请启用自动迁移")
	}
	return nil
}
