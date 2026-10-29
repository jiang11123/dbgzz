package database

import (
	"fmt"
	"gorm.io/gorm"
)

func migrateAssistantProductionAuthorization(tx *gorm.DB) error {
	return ensureSQLiteColumn(tx, "assistant_turns", "generation_authorization_json", "TEXT")
}

func requireAssistantProductionAuthorization(db *gorm.DB) error {
	has, err := sqliteHasColumn(db, "assistant_turns", "generation_authorization_json")
	if err != nil {
		return err
	}
	if !has {
		return fmt.Errorf("助手制作授权结构缺失，请启用自动迁移")
	}
	return nil
}
