package database

import (
	"fmt"

	"gorm.io/gorm"
)

func sqliteHasColumn(db *gorm.DB, table, column string) (bool, error) {
	var columns []struct{ Name string }
	if err := db.Raw("PRAGMA table_info(" + table + ")").Scan(&columns).Error; err != nil {
		return false, fmt.Errorf("读取本地表 %s 列: %w", table, err)
	}
	for _, item := range columns {
		if item.Name == column {
			return true, nil
		}
	}
	return false, nil
}

func sqliteHasNamedIndex(db *gorm.DB, table, name string) (bool, error) {
	var indexes []struct{ Name string }
	if err := db.Raw("PRAGMA index_list(" + table + ")").Scan(&indexes).Error; err != nil {
		return false, fmt.Errorf("读取本地表 %s 索引: %w", table, err)
	}
	for _, index := range indexes {
		if index.Name == name {
			return true, nil
		}
	}
	return false, nil
}

func ensureSQLiteColumn(tx *gorm.DB, table, column, definition string) error {
	if !tx.Migrator().HasTable(table) {
		return fmt.Errorf("本地数据库表 %s 不存在，无法添加列 %s", table, column)
	}
	has, err := sqliteHasColumn(tx, table, column)
	if err != nil {
		return err
	}
	if has {
		return nil
	}
	if err := tx.Exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition).Error; err != nil {
		return fmt.Errorf("添加本地数据库列 %s.%s: %w", table, column, err)
	}
	return nil
}

func ensureSQLiteIndex(tx *gorm.DB, table, name, createSQL string) error {
	has, err := sqliteHasNamedIndex(tx, table, name)
	if err != nil {
		return err
	}
	if has {
		return nil
	}
	if err := tx.Exec(createSQL).Error; err != nil {
		return fmt.Errorf("创建本地数据库索引 %s: %w", name, err)
	}
	return nil
}

func ensureTaskFailureDiagnostics(tx *gorm.DB) error {
	return ensureSQLiteColumn(tx, "tasks", "failure_diagnostics", "TEXT")
}

func ensureTaskClientOperation(tx *gorm.DB) error {
	if err := ensureSQLiteColumn(tx, "tasks", "client_operation_id", "TEXT"); err != nil {
		return err
	}
	return ensureTaskUserClientOpIndex(tx)
}

func ensureTaskClientOperationHash(tx *gorm.DB) error {
	return ensureSQLiteColumn(tx, "tasks", "client_operation_hash", "TEXT")
}

func ensureTaskUserClientOpIndex(tx *gorm.DB) error {
	return ensureSQLiteIndex(tx, "tasks", "idx_tasks_user_client_op",
		"CREATE UNIQUE INDEX idx_tasks_user_client_op ON tasks(user_id, client_operation_id)")
}

func ensureAgentOperationTurnAttribution(tx *gorm.DB) error {
	if err := ensureAgentOpRecordsTable(tx); err != nil {
		return err
	}
	return ensureAgentOpTurnIndex(tx)
}

func ensureAgentOpRecordsTable(tx *gorm.DB) error {
	if tx.Migrator().HasTable("agent_op_records") {
		if err := ensureSQLiteColumn(tx, "agent_op_records", "op", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "agent_op_records", "payload_hash", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "agent_op_records", "status", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "agent_op_records", "result_json", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "agent_op_records", "turn_id", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "agent_op_records", "created_at", "DATETIME"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "agent_op_records", "updated_at", "DATETIME"); err != nil {
			return err
		}
		return ensureAgentOpTurnIndex(tx)
	}
	if err := tx.Exec(`CREATE TABLE agent_op_records (
		user_id TEXT,
		op_id TEXT,
		op TEXT,
		payload_hash TEXT,
		status TEXT,
		result_json TEXT,
		turn_id TEXT,
		created_at DATETIME,
		updated_at DATETIME,
		PRIMARY KEY (user_id, op_id)
	)`).Error; err != nil {
		return fmt.Errorf("创建 Agent 操作表: %w", err)
	}
	return ensureAgentOpTurnIndex(tx)
}

func ensureAgentOpTurnIndex(tx *gorm.DB) error {
	return ensureSQLiteIndex(tx, "agent_op_records", "idx_agent_op_records_turn_id",
		"CREATE INDEX idx_agent_op_records_turn_id ON agent_op_records(turn_id)")
}

func ensureImageSubmissionsTable(tx *gorm.DB) error {
	if tx.Migrator().HasTable("image_submissions") {
		if err := ensureSQLiteColumn(tx, "image_submissions", "task_id", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "image_submissions", "user_id", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "image_submissions", "request_cipher", "TEXT"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "image_submissions", "send_count", "INTEGER"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "image_submissions", "response_accepted", "NUMERIC"); err != nil {
			return err
		}
		if err := ensureSQLiteColumn(tx, "image_submissions", "created_at", "DATETIME"); err != nil {
			return err
		}
		if err := ensureSQLiteIndex(tx, "image_submissions", "idx_image_submissions_task_id",
			"CREATE INDEX idx_image_submissions_task_id ON image_submissions(task_id)"); err != nil {
			return err
		}
		return ensureSQLiteIndex(tx, "image_submissions", "idx_image_submissions_user_id",
			"CREATE INDEX idx_image_submissions_user_id ON image_submissions(user_id)")
	}
	if err := tx.Exec(`CREATE TABLE image_submissions (
		attempt_id TEXT PRIMARY KEY,
		task_id TEXT,
		user_id TEXT,
		request_cipher TEXT,
		send_count INTEGER,
		response_accepted NUMERIC,
		created_at DATETIME
	)`).Error; err != nil {
		return fmt.Errorf("创建图片恢复表: %w", err)
	}
	if err := ensureSQLiteIndex(tx, "image_submissions", "idx_image_submissions_task_id",
		"CREATE INDEX idx_image_submissions_task_id ON image_submissions(task_id)"); err != nil {
		return err
	}
	return ensureSQLiteIndex(tx, "image_submissions", "idx_image_submissions_user_id",
		"CREATE INDEX idx_image_submissions_user_id ON image_submissions(user_id)")
}

func migrateAssistantBusinessTurns(tx *gorm.DB) error {
	if err := ensureAssistantTurnsTable(tx); err != nil {
		return err
	}
	return requireAssistantTurnsSchema(tx)
}

func ensureAssistantTurnsTable(tx *gorm.DB) error {
	if tx.Migrator().HasTable("assistant_turns") {
		for _, column := range []struct{ name, definition string }{
			{"user_id", "TEXT"},
			{"canvas_id", "TEXT"},
			{"revision_before", "INTEGER"},
			{"created_at", "DATETIME"},
			{"updated_at", "DATETIME"},
			{"state", "TEXT"},
			{"selected_node_ids", "TEXT"},
			{"referenced_asset_ids", "TEXT"},
			{"referenced_canvas_ids", "TEXT"},
			{"associated_asset_ids", "TEXT"},
			{"associated_task_ids", "TEXT"},
			{"undone", "NUMERIC"},
			{"change_json", "TEXT"},
			{"document", "TEXT"},
		} {
			if err := ensureSQLiteColumn(tx, "assistant_turns", column.name, column.definition); err != nil {
				return err
			}
		}
		return ensureAssistantTurnsUserCanvasIndex(tx)
	}
	if err := tx.Exec(`CREATE TABLE assistant_turns (
		turn_id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		canvas_id TEXT NOT NULL,
		revision_before INTEGER NOT NULL DEFAULT 0,
		created_at DATETIME,
		updated_at DATETIME,
		state TEXT NOT NULL,
		selected_node_ids TEXT,
		referenced_asset_ids TEXT,
		referenced_canvas_ids TEXT,
		associated_asset_ids TEXT,
		associated_task_ids TEXT,
		undone NUMERIC NOT NULL DEFAULT 0,
		change_json TEXT,
		document TEXT
	)`).Error; err != nil {
		return fmt.Errorf("创建助手业务回合表: %w", err)
	}
	return ensureAssistantTurnsUserCanvasIndex(tx)
}

func ensureAssistantTurnsUserCanvasIndex(tx *gorm.DB) error {
	return ensureSQLiteIndex(tx, "assistant_turns", "idx_assistant_turns_user_canvas",
		"CREATE INDEX idx_assistant_turns_user_canvas ON assistant_turns(user_id, canvas_id)")
}

func migrateCreationConversations(tx *gorm.DB) error {
	if err := ensureCreationConversationsTable(tx); err != nil {
		return err
	}
	return requireCreationConversationsSchema(tx)
}

func ensureCreationConversationsTable(tx *gorm.DB) error {
	if tx.Migrator().HasTable("creation_conversations") {
		for _, column := range []struct{ name, definition string }{
			{"revision", "INTEGER NOT NULL DEFAULT 0"},
			{"document", "TEXT NOT NULL DEFAULT '{}'"},
			{"deleted", "NUMERIC NOT NULL DEFAULT 0"},
			{"import_operation_id", "TEXT"},
			{"import_hash", "TEXT"},
			{"created_at", "DATETIME"},
			{"updated_at", "DATETIME"},
		} {
			if err := ensureSQLiteColumn(tx, "creation_conversations", column.name, column.definition); err != nil {
				return err
			}
		}
		return ensureCreationConversationsIndexes(tx)
	}
	if err := tx.Exec(`CREATE TABLE creation_conversations (
		user_id TEXT NOT NULL,
		conversation_id TEXT NOT NULL,
		revision INTEGER NOT NULL DEFAULT 0,
		document TEXT NOT NULL,
		deleted NUMERIC NOT NULL DEFAULT 0,
		import_operation_id TEXT,
		import_hash TEXT,
		created_at DATETIME,
		updated_at DATETIME,
		PRIMARY KEY (user_id, conversation_id)
	)`).Error; err != nil {
		return fmt.Errorf("创建创作对话表: %w", err)
	}
	return ensureCreationConversationsIndexes(tx)
}

func ensureCreationConversationsIndexes(tx *gorm.DB) error {
	if err := ensureCreationConversationsUserUpdatedIndex(tx); err != nil {
		return err
	}
	return ensureCreationConversationsUserImportIndex(tx)
}

func ensureCreationConversationsUserUpdatedIndex(tx *gorm.DB) error {
	return ensureSQLiteIndex(tx, "creation_conversations", "idx_creation_conversations_user_updated",
		"CREATE INDEX idx_creation_conversations_user_updated ON creation_conversations(user_id, updated_at)")
}

func ensureCreationConversationsUserImportIndex(tx *gorm.DB) error {
	return ensureSQLiteIndex(tx, "creation_conversations", "idx_creation_conversations_user_import",
		"CREATE UNIQUE INDEX idx_creation_conversations_user_import ON creation_conversations(user_id, import_operation_id) WHERE import_operation_id IS NOT NULL AND import_operation_id != ''")
}

func requireCreationConversationsSchema(db *gorm.DB) error {
	if !db.Migrator().HasTable("creation_conversations") {
		return fmt.Errorf("本地创作对话表缺失，请启用自动迁移")
	}
	for _, column := range []string{
		"user_id", "conversation_id", "revision", "document", "deleted",
		"import_operation_id", "import_hash", "created_at", "updated_at",
	} {
		has, err := sqliteHasColumn(db, "creation_conversations", column)
		if err != nil {
			return err
		}
		if !has {
			return fmt.Errorf("本地创作对话表缺失列 %s", column)
		}
	}
	if err := requireSQLitePrimaryKey(db, "creation_conversations", []string{"user_id", "conversation_id"}); err != nil {
		return err
	}
	valid, err := matchesSQLiteIndex(db, sqliteIndexContract{
		table: "creation_conversations", name: "idx_creation_conversations_user_updated",
		columns: []string{"user_id", "updated_at"}, unique: false,
	})
	if err != nil {
		return err
	}
	if !valid {
		return fmt.Errorf("本地数据库索引 idx_creation_conversations_user_updated 定义不完整")
	}
	valid, err = matchesSQLiteIndex(db, sqliteIndexContract{
		table: "creation_conversations", name: "idx_creation_conversations_user_import",
		columns: []string{"user_id", "import_operation_id"}, unique: true, partial: true,
		whereSQL: "import_operation_id IS NOT NULL",
	})
	if err != nil {
		return err
	}
	if !valid {
		return fmt.Errorf("本地数据库索引 idx_creation_conversations_user_import 定义不完整")
	}
	return nil
}

func requireAssistantTurnsSchema(db *gorm.DB) error {
	if !db.Migrator().HasTable("assistant_turns") {
		return fmt.Errorf("本地助手业务回合表缺失，请启用自动迁移")
	}
	for _, column := range []string{
		"turn_id", "user_id", "canvas_id", "revision_before", "created_at", "updated_at",
		"state", "selected_node_ids", "referenced_asset_ids", "referenced_canvas_ids",
		"associated_asset_ids", "associated_task_ids", "undone", "change_json", "document",
	} {
		has, err := sqliteHasColumn(db, "assistant_turns", column)
		if err != nil {
			return err
		}
		if !has {
			return fmt.Errorf("本地助手业务回合表缺失列 %s", column)
		}
	}
	if err := requireSQLitePrimaryKey(db, "assistant_turns", []string{"turn_id"}); err != nil {
		return err
	}
	valid, err := matchesSQLiteIndex(db, sqliteIndexContract{
		table: "assistant_turns", name: "idx_assistant_turns_user_canvas",
		columns: []string{"user_id", "canvas_id"}, unique: false,
	})
	if err != nil {
		return err
	}
	if !valid {
		return fmt.Errorf("本地数据库索引 idx_assistant_turns_user_canvas 定义不完整")
	}
	return nil
}
