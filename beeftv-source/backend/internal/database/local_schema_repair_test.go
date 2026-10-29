package database

import (
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func TestSchemaMigrationCrashHelper(t *testing.T) {
	path := os.Getenv("BEEFTV_SCHEMA_CRASH_FIXTURE")
	if path == "" {
		t.Skip("child-process crash fixture only")
	}
	db, err := Open(Config{Driver: "sqlite", DSN: path})
	if err != nil {
		t.Fatal(err)
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		if err := repairProductAgentContracts(tx); err != nil {
			return err
		}
		if err := tx.Create(&localSchemaMigration{Version: 9, Name: "repair-product-agent-contracts"}).Error; err != nil {
			return err
		}
		if err := os.WriteFile(path+".uncommitted", []byte("DDL and ledger written, not committed"), 0600); err != nil {
			return err
		}
		select {} // Parent kills this process while SQLite owns the transaction.
	})
	t.Fatalf("crash fixture unexpectedly returned: %v", err)
}

func TestSchemaRepairRecoversAfterProcessKill(t *testing.T) {
	db, path := brokenV8Fixture(t, "ALTER TABLE tasks DROP COLUMN failure_diagnostics")
	connection, _ := db.DB()
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestSchemaMigrationCrashHelper$", "-test.v")
	cmd.Env = append(os.Environ(), "BEEFTV_SCHEMA_CRASH_FIXTURE="+path)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill() }()
	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, err := os.Stat(path + ".uncommitted"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child did not reach uncommitted migration")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("child was not interrupted")
	}
	reopened, err := Open(Config{Driver: "sqlite", DSN: path})
	if err != nil {
		t.Fatal(err)
	}
	second, _ := reopened.DB()
	defer second.Close()
	version, err := currentSchemaVersion(reopened)
	if err != nil || version != 8 || reopened.Migrator().HasColumn("tasks", "failure_diagnostics") {
		t.Fatalf("uncommitted migration survived kill: %d %v", version, err)
	}
	if err := MigrateLocalSchema(reopened); err != nil {
		t.Fatal(err)
	}
	var retained model.Task
	if err := reopened.First(&retained, "id = ?", "retained").Error; err != nil || retained.ResultJSON != `{"output":"keep"}` {
		t.Fatalf("kill recovery lost data: %+v %v", retained, err)
	}
}

// A disk fixture with the already-shipped candidate ledger, independently of
// the version supported by the binary under test.
func brokenV8Fixture(t *testing.T, damage string) (*gorm.DB, string) {
	t.Helper()
	db, path := openFileDB(t)
	stampHistorical(t, db, "preview-v8")
	if err := db.Exec("UPDATE tasks SET id = 'retained', result_json = ?, error = 'historical' WHERE id = 'task'", `{"output":"keep"}`).Error; err != nil {
		t.Fatal(err)
	}
	if damage != "" {
		if err := db.Exec(damage).Error; err != nil {
			t.Fatal(err)
		}
	}
	return db, path
}

func TestSchemaRepairV8MissingDiagnosticsAndRecovery(t *testing.T) {
	for name, damage := range map[string]string{
		"diagnostics":     "ALTER TABLE tasks DROP COLUMN failure_diagnostics",
		"recovery-table":  "DROP TABLE image_submissions",
		"recovery-column": "ALTER TABLE image_submissions DROP COLUMN response_accepted",
	} {
		t.Run(name, func(t *testing.T) {
			db, path := brokenV8Fixture(t, damage)
			if name == "diagnostics" {
				err := db.Create(&model.Task{ID: "must-fail-before-repair"}).Error
				if err == nil || !strings.Contains(err.Error(), "no column named failure_diagnostics") {
					t.Fatalf("missing-column incident not reproduced: %v", err)
				}
				t.Logf("reproduced SQLite incident: %v", err)
			}
			if err := RequireLocalSchema(db); err == nil {
				t.Fatal("historical incomplete schema became Ready")
			}
			if err := MigrateLocalSchema(db); err != nil {
				t.Fatalf("explicit repair migration: %v", err)
			}
			if err := RequireLocalSchema(db); err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.Task{ID: "after-repair", FailureDiagnostics: &model.TaskFailureDiagnostics{Source: "local_result"}}).Error; err != nil {
				t.Fatal(err)
			}
			connection, _ := db.DB()
			if err := connection.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := Open(Config{Driver: "sqlite", DSN: path})
			if err != nil {
				t.Fatal(err)
			}
			second, _ := reopened.DB()
			defer second.Close()
			if err := MigrateLocalSchema(reopened); err != nil {
				t.Fatal(err)
			}
			var retained model.Task
			if err := reopened.First(&retained, "id = ?", "retained").Error; err != nil || retained.ResultJSON != `{"output":"keep"}` || retained.Error != "historical" {
				t.Fatalf("data lost: %+v %v", retained, err)
			}
			var old localSchemaMigration
			if err := reopened.First(&old, "version = 8").Error; err != nil || old.Name != "reconcile-product-agent-schema" || !old.AppliedAt.Equal(time.Unix(800, 0).UTC()) {
				t.Fatalf("historical ledger rewritten: %+v %v", old, err)
			}
		})
	}
}

func TestSchemaReadinessRejectsIncompleteRecoveryAndFalseUniqueIndex(t *testing.T) {
	for name, damage := range map[string][]string{
		"recovery-column":           {"ALTER TABLE image_submissions DROP COLUMN response_accepted"},
		"agent-column":              {"ALTER TABLE agent_op_records DROP COLUMN payload_hash"},
		"false-unique-index":        {"DROP INDEX idx_tasks_user_client_op", "CREATE INDEX idx_tasks_user_client_op ON tasks(user_id,client_operation_id)"},
		"image-missing-primary-key": {"CREATE TABLE image_copy AS SELECT * FROM image_submissions", "DROP TABLE image_submissions", "ALTER TABLE image_copy RENAME TO image_submissions"},
		"agent-missing-primary-key": {"CREATE TABLE agent_copy AS SELECT * FROM agent_op_records", "DROP TABLE agent_op_records", "ALTER TABLE agent_copy RENAME TO agent_op_records", "CREATE INDEX idx_agent_op_records_turn_id ON agent_op_records(turn_id)"},
		"tasks-missing-primary-key": {"CREATE TABLE task_copy AS SELECT * FROM tasks", "DROP TABLE tasks", "ALTER TABLE task_copy RENAME TO tasks", "CREATE UNIQUE INDEX idx_tasks_user_client_op ON tasks(user_id,client_operation_id)"},
	} {
		t.Run(name, func(t *testing.T) {
			db, _ := brokenV8Fixture(t, "")
			if err := MigrateLocalSchema(db); err != nil {
				t.Fatal(err)
			}
			for _, sql := range damage {
				if err := db.Exec(sql).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := RequireLocalSchema(db); err == nil {
				t.Fatal("incomplete runtime contract reported Ready")
			}
			status, err := ReadSchemaStatus(db)
			if err != nil || status.Ready || status.Current != CurrentSchemaVersion {
				t.Fatalf("damaged schema status hides actual version: %+v %v", status, err)
			}
		})
	}
}

func TestSchemaRepairV9TransactionRollbackAndIndexIntegrity(t *testing.T) {
	for _, failure := range []string{"ledger-interruption", "duplicate-identity"} {
		t.Run(failure, func(t *testing.T) {
			db, _ := brokenV8Fixture(t, "ALTER TABLE tasks DROP COLUMN failure_diagnostics")
			for _, sql := range []string{"DROP INDEX idx_tasks_user_client_op", "CREATE INDEX idx_tasks_user_client_op ON tasks(user_id,client_operation_id)"} {
				if err := db.Exec(sql).Error; err != nil {
					t.Fatal(err)
				}
			}
			if failure == "ledger-interruption" {
				if err := db.Exec("CREATE TRIGGER fail_v9 BEFORE INSERT ON local_schema_migrations WHEN NEW.version=9 BEGIN SELECT RAISE(ABORT,'injected v9 ledger failure'); END").Error; err != nil {
					t.Fatal(err)
				}
			} else {
				if err := db.Exec("INSERT INTO tasks(id,user_id,client_operation_id) VALUES ('duplicate-a','owner','same'),('duplicate-b','owner','same')").Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := MigrateLocalSchema(db); err == nil {
				t.Fatal("injected failure accepted")
			}
			version, err := currentSchemaVersion(db)
			if err != nil || version != 8 || db.Migrator().HasColumn("tasks", "failure_diagnostics") {
				t.Fatalf("partial migration survived rollback: %d %v", version, err)
			}
			valid, err := matchesSQLiteIndex(db, reconciledIndexes[0])
			if err != nil || valid {
				t.Fatalf("index replacement escaped failed transaction: %v %v", valid, err)
			}
			if failure == "duplicate-identity" {
				var count int64
				if err := db.Table("tasks").Where("client_operation_id = 'same'").Count(&count).Error; err != nil || count != 2 {
					t.Fatalf("duplicate rows lost: %d %v", count, err)
				}
				return
			}
			if err := db.Exec("DROP TRIGGER fail_v9").Error; err != nil {
				t.Fatal(err)
			}
			if err := MigrateLocalSchema(db); err != nil {
				t.Fatal(err)
			}
			if err := db.Exec("INSERT INTO tasks(id,user_id,client_operation_id) VALUES ('one','owner','same')").Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Exec("INSERT INTO tasks(id,user_id,client_operation_id) VALUES ('two','owner','same')").Error; err == nil {
				t.Fatal("repaired index permits duplicate identity")
			}
		})
	}
}

func TestSchemaRepairFutureDamagedDatabaseIsUntouched(t *testing.T) {
	for _, damage := range []string{"ALTER TABLE tasks DROP COLUMN failure_diagnostics", "DROP TABLE image_submissions"} {
		db, _ := brokenV8Fixture(t, damage)
		if err := db.Create(&localSchemaMigration{Version: CurrentSchemaVersion + 1, Name: "future"}).Error; err != nil {
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
		if !reflect.DeepEqual(before, after) {
			t.Fatal("future schema changed")
		}
	}
}

func TestSchemaRepairV8RefusesMissingPrimaryKeyWithoutChangingRows(t *testing.T) {
	for _, table := range []string{"tasks", "image_submissions", "agent_op_records"} {
		t.Run(table, func(t *testing.T) {
			db, _ := brokenV8Fixture(t, "ALTER TABLE tasks DROP COLUMN failure_diagnostics")
			for _, sql := range []string{"CREATE TABLE damaged_copy AS SELECT * FROM " + table, "DROP TABLE " + table, "ALTER TABLE damaged_copy RENAME TO " + table} {
				if err := db.Exec(sql).Error; err != nil {
					t.Fatal(err)
				}
			}
			var before int64
			if err := db.Table(table).Count(&before).Error; err != nil {
				t.Fatal(err)
			}
			if err := MigrateLocalSchema(db); err == nil || !strings.Contains(err.Error(), "主键") {
				t.Fatalf("malformed identity not explicitly blocked: %v", err)
			}
			version, err := currentSchemaVersion(db)
			if err != nil || version != 8 || db.Migrator().HasColumn("tasks", "failure_diagnostics") {
				t.Fatalf("partial repair survived: %d %v", version, err)
			}
			var after int64
			if err := db.Table(table).Count(&after).Error; err != nil || before != after {
				t.Fatalf("rows changed: %d %d %v", before, after, err)
			}
		})
	}
}
