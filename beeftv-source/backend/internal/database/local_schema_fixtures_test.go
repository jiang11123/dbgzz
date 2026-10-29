package database

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

type historicalLayout struct {
	name           string
	versions       []localSchemaMigration
	diagnostics    bool
	clientOpID     bool
	clientOpHash   bool
	uniqueClientOp bool
	agentTable     bool
	agentTurnID    bool
	imageTable     bool
}

func historicalLayouts() map[string]historicalLayout {
	at := func(version int64, name string) localSchemaMigration {
		return localSchemaMigration{Version: version, Name: name, AppliedAt: time.Unix(version*100, 0).UTC()}
	}
	core := []localSchemaMigration{at(1, "local-core-schema"), at(2, "retire-hosted-schema")}
	return map[string]historicalLayout{
		"product-v1": {name: "product-v1", versions: []localSchemaMigration{at(1, "local-core-schema")}},
		"product-v2": {name: "product-v2", versions: core},
		"product-v3": {
			name: "product-v3", versions: append(append([]localSchemaMigration{}, core...), at(3, "task-failure-diagnostics")),
			diagnostics: true,
		},
		"product-v3-missing": {
			name: "product-v3-missing", versions: append(append([]localSchemaMigration{}, core...), at(3, "task-failure-diagnostics")),
		},
		"product-v7": {
			name: "product-v7",
			versions: append(append([]localSchemaMigration{}, core...),
				at(3, "task-failure-diagnostics"), at(7, "product-image-recovery-and-diagnostics")),
			diagnostics: true, imageTable: true,
		},
		"product-v7-missing": {
			name: "product-v7-missing",
			versions: append(append([]localSchemaMigration{}, core...),
				at(3, "task-failure-diagnostics"), at(7, "unrelated-branch-v7")),
			diagnostics: true,
		},
		"agent-v3": {
			name: "agent-v3", versions: append(append([]localSchemaMigration{}, core...), at(3, "agent-operation-records")),
			agentTable: true,
		},
		"agent-v4": {
			name: "agent-v4",
			versions: append(append([]localSchemaMigration{}, core...),
				at(3, "agent-operation-records"), at(4, "task-client-operation")),
			agentTable: true, clientOpID: true, uniqueClientOp: true,
		},
		"agent-v5": {
			name: "agent-v5",
			versions: append(append([]localSchemaMigration{}, core...),
				at(3, "agent-operation-records"), at(4, "task-client-operation"), at(5, "task-client-operation-hash")),
			agentTable: true, clientOpID: true, clientOpHash: true, uniqueClientOp: true,
		},
		"agent-v6": {
			name: "agent-v6",
			versions: append(append([]localSchemaMigration{}, core...),
				at(3, "agent-operation-records"), at(4, "task-client-operation"),
				at(5, "task-client-operation-hash"), at(6, "agent-operation-turn-attribution")),
			agentTable: true, agentTurnID: true, clientOpID: true, clientOpHash: true, uniqueClientOp: true,
		},
		"image-v3": {
			name: "image-v3", versions: append(append([]localSchemaMigration{}, core...), at(3, "image-submission-recovery")),
			imageTable: true,
		},
		"preview-v8": {
			name: "preview-v8",
			versions: append(append([]localSchemaMigration{}, core...),
				at(3, "agent-operation-records"), at(4, "task-client-operation"),
				at(5, "task-client-operation-hash"), at(6, "agent-operation-turn-attribution"),
				at(8, "reconcile-product-agent-schema")),
			diagnostics: true, clientOpID: true, clientOpHash: true, uniqueClientOp: true,
			agentTable: true, agentTurnID: true, imageTable: true,
		},
		"preview-v9": {
			name: "preview-v9",
			versions: append(append([]localSchemaMigration{}, core...),
				at(3, "task-failure-diagnostics"), at(4, "task-client-operation"),
				at(5, "task-client-operation-hash"), at(6, "agent-operation-turn-attribution"),
				at(8, "reconcile-product-agent-schema"), at(9, "repair-product-agent-contracts")),
			diagnostics: true, clientOpID: true, clientOpHash: true, uniqueClientOp: true,
			agentTable: true, agentTurnID: true, imageTable: true,
		},
	}
}

func openFileDB(t *testing.T) (*gorm.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "workspace.db")
	db, err := Open(Config{Driver: "sqlite", DSN: path})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	return db, path
}

func openHistorical(t *testing.T, name string) *gorm.DB {
	t.Helper()
	db, _ := openFileDB(t)
	stampHistorical(t, db, name)
	return db
}

func stampHistorical(t *testing.T, db *gorm.DB, name string) historicalLayout {
	t.Helper()
	layout, ok := historicalLayouts()[name]
	if !ok {
		t.Fatalf("unknown historical layout %s", name)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if err := db.Exec(sql, args...).Error; err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	if err := db.AutoMigrate(&localSchemaMigration{}, &model.Workspace{}, &model.Project{}, &model.CanvasProject{}, &model.Resource{}); err != nil {
		t.Fatal(err)
	}
	exec(historicalTasksSQL(layout))
	exec("ALTER TABLE tasks ADD COLUMN preview_marker TEXT")
	exec("ALTER TABLE tasks ADD COLUMN legacy_branch_payload TEXT")
	if layout.uniqueClientOp {
		exec("CREATE UNIQUE INDEX idx_tasks_user_client_op ON tasks(user_id, client_operation_id)")
	}
	if layout.agentTable {
		exec(historicalAgentOpSQL(layout.agentTurnID))
		exec("ALTER TABLE agent_op_records ADD COLUMN preview_receipt TEXT")
		if layout.agentTurnID {
			exec("CREATE INDEX idx_agent_op_records_turn_id ON agent_op_records(turn_id)")
		}
	}
	if layout.imageTable {
		exec(historicalImageSQL())
		exec("ALTER TABLE image_submissions ADD COLUMN preview_cipher_note TEXT")
	}
	for _, row := range layout.versions {
		if err := db.Create(&localSchemaMigration{Version: row.Version, Name: row.Name, AppliedAt: row.AppliedAt}).Error; err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO tasks(id,user_id,type,status,input_json,result_json,error,preview_marker,legacy_branch_payload)
		VALUES ('task','owner','canvas_image','failed','{"source":"original"}','{"resourceId":"resource"}','historical error','keep','branch-payload')`)
	if layout.diagnostics {
		exec(`UPDATE tasks SET failure_diagnostics = '{"source":"gateway","requestId":"request"}' WHERE id = 'task'`)
	}
	if layout.clientOpID {
		exec(`UPDATE tasks SET client_operation_id = 'operation' WHERE id = 'task'`)
	}
	if layout.clientOpHash {
		exec(`UPDATE tasks SET client_operation_hash = 'hash' WHERE id = 'task'`)
	}
	if layout.agentTable {
		if layout.agentTurnID {
			exec(`INSERT INTO agent_op_records(user_id,op_id,status,result_json,turn_id,preview_receipt) VALUES ('owner','operation','completed','{"taskId":"task"}','turn','keep-receipt')`)
		} else {
			exec(`INSERT INTO agent_op_records(user_id,op_id,status,result_json,preview_receipt) VALUES ('owner','operation','completed','{"taskId":"task"}','keep-receipt')`)
		}
	}
	if layout.imageTable {
		exec(`INSERT INTO image_submissions(attempt_id,task_id,user_id,request_cipher,send_count,response_accepted,preview_cipher_note) VALUES ('attempt','task','owner','opaque-fixture',4,1,'keep-note')`)
	}
	if err := db.Create(&model.Resource{ID: "resource", UserID: "owner", ObjectKey: "fixture-output.png"}).Error; err != nil {
		t.Fatal(err)
	}
	return layout
}

func historicalTasksSQL(layout historicalLayout) string {
	cols := []string{
		"`creation_submission_id` TEXT", "`id` TEXT", "`user_id` TEXT", "`trace_id` TEXT", "`request_id` TEXT", "`project_id` TEXT",
	}
	if layout.clientOpID {
		cols = append(cols, "`client_operation_id` TEXT")
	}
	if layout.clientOpHash {
		cols = append(cols, "`client_operation_hash` TEXT")
	}
	cols = append(cols,
		"`type` TEXT", "`status` TEXT", "`stage` TEXT", "`progress` INTEGER", "`prompt` TEXT", "`operation` TEXT",
		"`provider` TEXT", "`model` TEXT", "`logical_model_id` TEXT", "`logical_model_revision_id` TEXT",
		"`route_id` TEXT", "`channel_model_id` TEXT", "`route_run` INTEGER", "`provider_request_id` TEXT",
		"`provider_cancel_status` TEXT", "`provider_cancel_error` TEXT", "`provider_cancel_attempts` INTEGER",
		"`provider_cancel_requested_at` DATETIME", "`provider_cancelled_at` DATETIME", "`provider_cancel_next_check_at` DATETIME",
		"`poll_stage` TEXT", "`next_poll_at` DATETIME", "`lease_owner` TEXT", "`lease_expires_at` DATETIME",
		"`input_json` TEXT", "`result_json` TEXT", "`text_draft` TEXT", "`error` TEXT",
	)
	if layout.diagnostics {
		cols = append(cols, "`failure_diagnostics` TEXT")
	}
	cols = append(cols, "`attempts` INTEGER", "`started_at` DATETIME", "`completed_at` DATETIME", "`created_at` DATETIME", "`updated_at` DATETIME")
	return "CREATE TABLE `tasks` (" + strings.Join(cols, ",") + ", PRIMARY KEY (`id`))"
}

func historicalAgentOpSQL(turnID bool) string {
	cols := "`user_id` TEXT,`op_id` TEXT,`op` TEXT,`payload_hash` TEXT,`status` TEXT,`result_json` TEXT"
	if turnID {
		cols += ",`turn_id` TEXT"
	}
	cols += ",`created_at` DATETIME,`updated_at` DATETIME"
	return "CREATE TABLE `agent_op_records` (" + cols + ", PRIMARY KEY (`user_id`,`op_id`))"
}

func historicalImageSQL() string {
	return `CREATE TABLE image_submissions (
		attempt_id TEXT PRIMARY KEY,
		task_id TEXT,
		user_id TEXT,
		request_cipher TEXT,
		send_count INTEGER,
		response_accepted NUMERIC,
		created_at DATETIME
	)`
}

func fixtureHasDiagnostics(history string) bool {
	layout, ok := historicalLayouts()[history]
	return ok && layout.diagnostics
}

func sqliteTableSQL(t *testing.T, db *gorm.DB, name string) string {
	t.Helper()
	var sql string
	if err := db.Raw("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", name).Scan(&sql).Error; err != nil {
		t.Fatal(err)
	}
	return sql
}

func mustColumn(t *testing.T, db *gorm.DB, table, column, want string) {
	t.Helper()
	has, err := sqliteHasColumn(db, table, column)
	if err != nil || !has {
		t.Fatalf("%s.%s missing: %v", table, column, err)
	}
	var value string
	if err := db.Raw("SELECT " + column + " FROM " + table + " LIMIT 1").Scan(&value).Error; err != nil || value != want {
		t.Fatalf("%s.%s = %q, want %q (%v)", table, column, value, want, err)
	}
}
