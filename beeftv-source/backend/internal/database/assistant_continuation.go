package database

import (
	"fmt"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func migrateAssistantContinuations(tx *gorm.DB) error {
	if err := tx.AutoMigrate(&model.AssistantContinuation{}); err != nil {
		return err
	}
	return requireAssistantContinuations(tx)
}
func requireAssistantContinuations(db *gorm.DB) error {
	stmt := &gorm.Statement{DB: db}
	if err := stmt.Parse(&model.AssistantContinuation{}); err != nil {
		return err
	}
	for _, column := range stmt.Schema.DBNames {
		has, err := sqliteHasColumn(db, stmt.Schema.Table, column)
		if err != nil {
			return err
		}
		if !has {
			return fmt.Errorf("助手接续回执缺失列 %s", column)
		}
	}
	if err := requireSQLitePrimaryKey(db, stmt.Schema.Table, []string{"id"}); err != nil {
		return err
	}
	valid, err := matchesSQLiteIndex(db, sqliteIndexContract{table: stmt.Schema.Table, name: "idx_assistant_continuation_turn", columns: []string{"turn_id"}, unique: true})
	if err != nil {
		return err
	}
	if !valid {
		return fmt.Errorf("助手接续回合唯一索引缺失")
	}
	return nil
}

func migrateAssistantContinuationIntentFence(tx *gorm.DB) error {
	if err := ensureSQLiteColumn(tx, "assistant_turns", "continuation_invalidated", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	return requireAssistantContinuationIntentFence(tx)
}

func requireAssistantContinuationIntentFence(db *gorm.DB) error {
	has, err := sqliteHasColumn(db, "assistant_turns", "continuation_invalidated")
	if err != nil {
		return err
	}
	if !has {
		return fmt.Errorf("助手接续意图状态缺失，请启用自动迁移")
	}
	return nil
}
