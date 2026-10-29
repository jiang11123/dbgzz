package database

import (
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestProductRecoverySameVersionMissingStructureFailsClosed(t *testing.T) {
	for _, missing := range []string{"image_submissions", "failure_diagnostics", "creation_conversations"} {
		t.Run(missing, func(t *testing.T) {
			db, err := Open(Config{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "workspace.db")})
			if err != nil {
				t.Fatal(err)
			}
			connection, _ := db.DB()
			defer connection.Close()
			if err := MigrateLocalSchema(db); err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&localSchemaMigration{}).Where("version = ?", CurrentSchemaVersion).Update("name", "different-branch-current-version").Error; err != nil {
				t.Fatal(err)
			}
			if missing == "image_submissions" {
				err = db.Migrator().DropTable(&model.ImageSubmission{})
			} else if missing == "creation_conversations" {
				err = db.Migrator().DropTable(&model.CreationConversation{})
			} else {
				err = db.Migrator().DropColumn(&model.Task{}, "FailureDiagnostics")
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := RequireLocalSchema(db); err == nil {
				t.Fatal("same-version damaged schema passed readiness")
			}
			status, err := ReadSchemaStatus(db)
			if err != nil || status.Ready {
				t.Fatalf("status=%+v err=%v", status, err)
			}
			if err := MigrateLocalSchema(db); err == nil {
				t.Fatal("same-version missing structure silently accepted")
			}
			version, err := currentSchemaVersion(db)
			if err != nil || version != CurrentSchemaVersion {
				t.Fatalf("ledger changed: %d %v", version, err)
			}
		})
	}
}

// Historical layouts are created from version-specific DDL, not by deleting
// columns from the current model. Unknown preview columns stay in place.
func TestProductRecoveryMigrationPreservesHistoricalSchemas(t *testing.T) {
	for _, history := range []string{"product-v3", "agent-v6", "image-v3"} {
		t.Run(history, func(t *testing.T) {
			db, path := openFileDB(t)
			layout := stampHistorical(t, db, history)
			if history == "image-v3" {
				if err := db.Exec("UPDATE image_submissions SET send_count = 5 WHERE attempt_id = 'attempt'").Error; err != nil {
					t.Fatal(err)
				}
			}
			if history == "agent-v6" {
				if err := db.Exec("UPDATE tasks SET client_operation_hash = 'payload-hash' WHERE id = 'task'").Error; err != nil {
					t.Fatal(err)
				}
			}
			updateSQL := "UPDATE tasks SET input_json = '{\"original\":true}', error = 'historical failure' WHERE id = 'task'"
			if layout.diagnostics {
				updateSQL = "UPDATE tasks SET input_json = '{\"original\":true}', error = 'historical failure', failure_diagnostics = NULL WHERE id = 'task'"
			}
			if err := db.Exec(updateSQL).Error; err != nil {
				t.Fatal(err)
			}
			connection, _ := db.DB()
			if err := connection.Close(); err != nil {
				t.Fatal(err)
			}
			db, err := Open(Config{Driver: "sqlite", DSN: path})
			if err != nil {
				t.Fatal(err)
			}
			connection, _ = db.DB()
			defer connection.Close()
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
			if task.InputJSON != `{"original":true}` || task.Error != "historical failure" || task.Status != model.TaskStatusFailed || task.FailureDiagnostics != nil {
				t.Fatalf("task changed: %+v", task)
			}
			mustColumn(t, db, "tasks", "preview_marker", "keep")
			if !db.Migrator().HasTable(&model.ImageSubmission{}) {
				t.Fatal("missing recovery table")
			}
			var ledger []localSchemaMigration
			if err := db.Order("version").Find(&ledger).Error; err != nil {
				t.Fatal(err)
			}
			if len(ledger) < len(layout.versions)+1 || ledger[len(ledger)-1].Version != CurrentSchemaVersion {
				t.Fatalf("ledger: %+v", ledger)
			}
			for i, row := range layout.versions {
				if ledger[i].Name != row.Name || !ledger[i].AppliedAt.Equal(row.AppliedAt) {
					t.Fatalf("historical ledger overwritten: %+v", ledger)
				}
			}
			if history == "agent-v6" {
				var extension struct{ ClientOperationID, ClientOperationHash string }
				if err := db.Table("tasks").Select("client_operation_id, client_operation_hash").Where("id = ?", "task").Scan(&extension).Error; err != nil {
					t.Fatal(err)
				}
				if extension.ClientOperationID != "operation" || extension.ClientOperationHash != "payload-hash" {
					t.Fatalf("extension changed: %+v", extension)
				}
				var receipt struct{ ResultJSON, TurnID string }
				if err := db.Table("agent_op_records").Where("op_id = ?", "operation").Scan(&receipt).Error; err != nil {
					t.Fatal(err)
				}
				if receipt.ResultJSON != `{"taskId":"task"}` || receipt.TurnID != "turn" {
					t.Fatalf("receipt changed: %+v", receipt)
				}
				mustColumn(t, db, "agent_op_records", "preview_receipt", "keep-receipt")
				if !db.Migrator().HasIndex("tasks", "idx_tasks_user_client_op") {
					t.Fatal("lost idempotency index")
				}
			}
			if history == "image-v3" {
				var row model.ImageSubmission
				if err := db.First(&row, "attempt_id = ?", "attempt").Error; err != nil {
					t.Fatal(err)
				}
				if row.SendCount != 5 || row.RequestCipher != "opaque-fixture" {
					t.Fatalf("recovery reset: %+v", row)
				}
				mustColumn(t, db, "image_submissions", "preview_cipher_note", "keep-note")
			}
		})
	}
}
