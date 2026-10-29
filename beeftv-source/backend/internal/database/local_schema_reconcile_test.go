package database

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func reconciliationFixture(t *testing.T, history string) *gorm.DB {
	t.Helper()
	return openHistorical(t, history)
}

func TestAgentProductReconcileHistoricalLedgers(t *testing.T) {
	for _, history := range []string{
		"product-v1", "product-v2", "product-v3", "product-v3-missing", "product-v7", "product-v7-missing",
		"agent-v3", "agent-v4", "agent-v5", "agent-v6", "image-v3", "preview-v8", "preview-v9",
	} {
		t.Run(history, func(t *testing.T) {
			db := reconciliationFixture(t, history)
			var before []localSchemaMigration
			if err := db.Find(&before).Error; err != nil {
				t.Fatal(err)
			}
			taskSQL := sqliteTableSQL(t, db, "tasks")
			for i := 0; i < 2; i++ {
				if err := MigrateLocalSchema(db); err != nil {
					t.Fatal(err)
				}
				if err := RequireLocalSchema(db); err != nil {
					t.Fatal(err)
				}
			}
			var task model.Task
			if err := db.First(&task, "id = ?", "task").Error; err != nil {
				t.Fatal(err)
			}
			if task.Error != "historical error" || task.Status != model.TaskStatusFailed || task.InputJSON != `{"source":"original"}` || task.ResultJSON != `{"resourceId":"resource"}` {
				t.Fatalf("task changed: %+v", task)
			}
			mustColumn(t, db, "tasks", "preview_marker", "keep")
			mustColumn(t, db, "tasks", "legacy_branch_payload", "branch-payload")
			if !strings.Contains(sqliteTableSQL(t, db, "tasks"), "preview_marker") || !strings.Contains(taskSQL, "preview_marker") {
				t.Fatal("unknown task columns were rebuilt away")
			}
			var diagnostic string
			if fixtureHasDiagnostics(history) {
				if err := db.Raw("SELECT failure_diagnostics FROM tasks WHERE id = 'task'").Scan(&diagnostic).Error; err != nil {
					t.Fatal(err)
				}
				if diagnostic != `{"source":"gateway","requestId":"request"}` {
					t.Fatalf("diagnostic changed: %s", diagnostic)
				}
			}
			for _, old := range before {
				var actual localSchemaMigration
				if err := db.First(&actual, "version = ?", old.Version).Error; err != nil {
					t.Fatal(err)
				}
				if actual.Name != old.Name || !actual.AppliedAt.Equal(old.AppliedAt) {
					t.Fatalf("ledger rewritten: %+v", actual)
				}
			}
			if layout := historicalLayouts()[history]; layout.agentTable {
				var receipt model.AgentOpRecord
				if err := db.First(&receipt, "op_id = ?", "operation").Error; err != nil {
					t.Fatal(err)
				}
				mustColumn(t, db, "agent_op_records", "preview_receipt", "keep-receipt")
				if receipt.ResultJSON != `{"taskId":"task"}` {
					t.Fatalf("agent data changed: %+v %+v", receipt, task)
				}
				if layout.agentTurnID && (receipt.TurnID != "turn" || task.ClientOperationID == nil || *task.ClientOperationID != "operation" || task.ClientOperationHash != "hash") {
					t.Fatalf("agent turn identity changed: %+v %+v", receipt, task)
				}
			}
			if history == "product-v7" || history == "image-v3" || history == "preview-v8" || history == "preview-v9" {
				var row model.ImageSubmission
				if err := db.First(&row, "attempt_id = ?", "attempt").Error; err != nil {
					t.Fatal(err)
				}
				if row.SendCount != 4 || !row.ResponseAccepted || row.RequestCipher != "opaque-fixture" {
					t.Fatalf("image identity changed: %+v", row)
				}
				mustColumn(t, db, "image_submissions", "preview_cipher_note", "keep-note")
			}
			var resource model.Resource
			if err := db.First(&resource, "id = ?", "resource").Error; err != nil || resource.ObjectKey != "fixture-output.png" {
				t.Fatalf("resource changed: %+v %v", resource, err)
			}
			if err := db.Exec("UPDATE tasks SET client_operation_id='unique' WHERE id='task'").Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Exec("INSERT INTO tasks(id,user_id,client_operation_id) VALUES ('duplicate','owner','unique')").Error; err == nil {
				t.Fatal("idempotency unique index not enforced")
			}
		})
	}
}

func TestAgentProductReconcileLedgerWriteFailureRollsBackDDL(t *testing.T) {
	db := reconciliationFixture(t, "product-v7")
	if err := db.Exec("CREATE TRIGGER fail_v8 BEFORE INSERT ON local_schema_migrations WHEN NEW.version=8 BEGIN SELECT RAISE(ABORT,'injected ledger failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err == nil || !strings.Contains(err.Error(), "injected ledger failure") {
		t.Fatalf("failure not injected: %v", err)
	}
	version, _ := currentSchemaVersion(db)
	if version != 7 || db.Migrator().HasTable(&model.AgentOpRecord{}) || db.Migrator().HasColumn(&model.Task{}, "ClientOperationID") {
		t.Fatal("failed v8 left partial schema or ledger")
	}
	if err := db.Exec("DROP TRIGGER fail_v8").Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
}

func TestAgentProductReconcileDuplicateIdentityFailsWithoutDataLoss(t *testing.T) {
	db := reconciliationFixture(t, "agent-v6")
	if err := db.Exec("DROP INDEX idx_tasks_user_client_op").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO tasks(id,user_id,client_operation_id) VALUES ('duplicate','owner','operation')").Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err == nil {
		t.Fatal("duplicate identities silently reconciled")
	}
	version, _ := currentSchemaVersion(db)
	if version != 6 || db.Migrator().HasTable(&model.ImageSubmission{}) || db.Migrator().HasColumn("tasks", "failure_diagnostics") {
		t.Fatal("failed index creation left partial v8")
	}
	var count int64
	if err := db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 2 {
		t.Fatalf("rows lost: %d %v", count, err)
	}
}

func TestAgentProductReconcileBackupRestoreUsesOldSchemaCopy(t *testing.T) {
	db := reconciliationFixture(t, "product-v7")
	backup := filepath.Join(t.TempDir(), "before-v8.db")
	if err := db.Exec("VACUUM INTO ?", backup).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(Config{Driver: "sqlite", DSN: backup})
	if err != nil {
		t.Fatal(err)
	}
	connection, _ := restored.DB()
	defer connection.Close()
	version, err := currentSchemaVersion(restored)
	if err != nil || version != 7 || restored.Migrator().HasTable(&model.AgentOpRecord{}) {
		t.Fatalf("backup changed: %d %v", version, err)
	}
	var result string
	if err := restored.Raw("SELECT result_json FROM tasks WHERE id='task'").Scan(&result).Error; err != nil || result != `{"resourceId":"resource"}` {
		t.Fatalf("restore result: %s %v", result, err)
	}
	if err := RequireLocalSchema(restored); err == nil {
		t.Fatal("new binary accepted old schema without migration")
	}
}

func TestAgentProductReconcileSameVersionDamageIsNotReady(t *testing.T) {
	db := reconciliationFixture(t, "product-v7")
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropTable(&model.ImageSubmission{}); err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err == nil {
		t.Fatal("v8 ledger hid missing structure")
	}
	if err := MigrateLocalSchema(db); err == nil {
		t.Fatal("v8 damage silently accepted by migrator")
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || status.Ready {
		t.Fatalf("ready after damage: %+v %v", status, err)
	}
}

func TestAgentProductReconcileRefusesFutureVersion(t *testing.T) {
	for _, history := range []string{"product-v2", "product-v3", "agent-v6", "preview-v8"} {
		t.Run(history, func(t *testing.T) {
			db := reconciliationFixture(t, history)
			if err := db.Create(&localSchemaMigration{Version: CurrentSchemaVersion + 1, Name: "future", AppliedAt: time.Now()}).Error; err != nil {
				t.Fatal(err)
			}
			var before []struct{ Type, Name, SQL string }
			if err := db.Raw("SELECT type,name,sql FROM sqlite_master ORDER BY name").Scan(&before).Error; err != nil {
				t.Fatal(err)
			}
			if err := MigrateLocalSchema(db); err == nil {
				t.Fatal("future schema accepted")
			}
			var after []struct{ Type, Name, SQL string }
			if err := db.Raw("SELECT type,name,sql FROM sqlite_master ORDER BY name").Scan(&after).Error; err != nil {
				t.Fatal(err)
			}
			if len(before) != len(after) {
				t.Fatal("future schema modified")
			}
			for i := range before {
				if before[i] != after[i] {
					t.Fatalf("future schema changed %s", after[i].Name)
				}
			}
			mustColumn(t, db, "tasks", "preview_marker", "keep")
		})
	}
}
