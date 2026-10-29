package database

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestFailedMigrationDoesNotAdvanceVersionAndCanRetry(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:local-schema-failed-step?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("CREATE TABLE billing_orders (id TEXT PRIMARY KEY)").Error; err != nil {
		t.Fatal(err)
	}
	injected := errors.New("injected migration failure")
	err = migrateLocalSchema(db, func(version int64) error {
		if version == 2 {
			return injected
		}
		return nil
	})
	if !errors.Is(err, injected) {
		t.Fatalf("migration error = %v, want injected failure", err)
	}
	version, err := currentSchemaVersion(db)
	if err != nil || version != 1 {
		t.Fatalf("version after failure = %d, err = %v", version, err)
	}
	if !db.Migrator().HasTable("billing_orders") {
		t.Fatal("failed migration removed hosted table before commit")
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	version, err = currentSchemaVersion(db)
	if err != nil || version != CurrentSchemaVersion || db.Migrator().HasTable("billing_orders") {
		t.Fatalf("retry result: version=%d hosted=%v err=%v", version, db.Migrator().HasTable("billing_orders"), err)
	}
}

func TestLocalSchemaRecordsVersionAndIsIdempotent(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:local-schema-version?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := MigrateLocalSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	var rows []localSchemaMigration
	if err := db.Order("version").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	want := canonicalLocalMigrations()
	if len(rows) != len(want) || rows[len(rows)-1].Version != CurrentSchemaVersion {
		t.Fatalf("recorded versions = %+v, current = %d", rows, CurrentSchemaVersion)
	}
	for i, row := range rows {
		if row.Version != want[i].version || row.Name != want[i].name {
			t.Fatalf("canonical identity mismatch at %d: %+v want v%d %s", i, row, want[i].version, want[i].name)
		}
	}
	if rows[2].Name != "task-failure-diagnostics" {
		t.Fatalf("fresh database used preview v3 identity: %s", rows[2].Name)
	}
}

func TestTaskDiagnosticsMigrationPreservesExistingTasks(t *testing.T) {
	db := openHistorical(t, "product-v2")
	if err := db.Exec("UPDATE tasks SET id = 'existing-task', error = '历史错误' WHERE id = 'task'").Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	var task model.Task
	if err := db.First(&task, "id = ?", "existing-task").Error; err != nil {
		t.Fatal(err)
	}
	if task.Error != "历史错误" || task.FailureDiagnostics != nil {
		t.Fatalf("task changed: %+v", task)
	}
	mustColumn(t, db, "tasks", "preview_marker", "keep")
}

func TestImageRecoveryMigrationUpgradesExistingWorkspace(t *testing.T) {
	db := openHistorical(t, "product-v2")
	if err := db.Exec("UPDATE tasks SET id = 'existing-image', user_id = 'user', type = 'canvas_image', status = 'failed', input_json = '{\"original\":true}' WHERE id = 'task'").Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if !db.Migrator().HasTable(&model.ImageSubmission{}) {
		t.Fatal("image submission table missing")
	}
	var task model.Task
	if err := db.First(&task, "id = ?", "existing-image").Error; err != nil {
		t.Fatal(err)
	}
	if task.InputJSON != `{"original":true}` || task.Status != model.TaskStatusFailed {
		t.Fatal("migration rewrote old task")
	}
	mustColumn(t, db, "tasks", "legacy_branch_payload", "branch-payload")
}

func TestHostedCleanupCreatesRecoverableSQLiteBackup(t *testing.T) {
	dataDir := t.TempDir()
	databasePath := filepath.Join(dataDir, "canvas.db")
	db, err := Open(Config{Driver: "sqlite", DSN: databasePath})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := db.Exec("CREATE TABLE billing_orders (id TEXT PRIMARY KEY)").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO billing_orders (id) VALUES ('legacy-order')").Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	backups, err := filepath.Glob(filepath.Join(dataDir, "backups", "before-schema-v*-*.db"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("backups = %v, err = %v", backups, err)
	}
	backup, err := Open(Config{Driver: "sqlite", DSN: backups[0]})
	if err != nil {
		t.Fatal(err)
	}
	backupConnection, err := backup.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer backupConnection.Close()
	var count int64
	if err := backup.Table("billing_orders").Where("id = ?", "legacy-order").Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("backup legacy order count = %d, err = %v", count, err)
	}
}

func TestLocalSchemaExcludesHostedCommerceTables(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:local-schema-no-commerce?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{
		"model_pricings", "credit_accounts", "credit_ledger_entries", "billing_orders",
		"topup_products", "payment_provider_configs", "payment_orders", "payment_notifications",
		"payment_reconciliation_runs", "payment_reconciliation_items", "redeem_batches", "redeem_codes",
		"channel_model_price_tiers", "logical_model_price_skus",
	} {
		if db.Migrator().HasTable(table) {
			t.Fatalf("local schema unexpectedly contains hosted commerce table %q", table)
		}
	}
}

func TestLocalSchemaUpgradePreservesLegacyModelVariantsWithoutPricing(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:local-schema-model-variant-upgrade?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TABLE channel_model_price_tiers (
		id TEXT PRIMARY KEY, channel_model_id TEXT, selector_key TEXT, selector_json TEXT,
		resolution TEXT, video_seconds INTEGER, provider_model_key TEXT, enabled BOOLEAN,
		billing_mode TEXT, unit_price_microcredits INTEGER,
		created_at DATETIME, updated_at DATETIME, deleted_at DATETIME
	)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO channel_model_price_tiers
		(id,channel_model_id,selector_key,selector_json,resolution,video_seconds,provider_model_key,enabled,billing_mode,unit_price_microcredits,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		"variant-1", "model-1", `{"quality":"2k"}`, `{"quality":"2k"}`, "2k", 0, "upstream-image-2k", true,
		"fixed_request", 999, time.Now(), time.Now()).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if db.Migrator().HasTable("channel_model_price_tiers") {
		t.Fatal("legacy pricing table survived migration")
	}
	var variant model.ChannelModelVariant
	if err := db.First(&variant, "id = ?", "variant-1").Error; err != nil {
		t.Fatal(err)
	}
	if variant.ProviderModelKey != "upstream-image-2k" || variant.SelectorKey != `{"quality":"2k"}` || !variant.Enabled {
		t.Fatalf("legacy executable variant was not preserved: %#v", variant)
	}
	for _, column := range []string{"billing_mode", "unit_price_microcredits", "price_configured"} {
		if db.Migrator().HasColumn("channel_model_variants", column) {
			t.Fatalf("local model variant retained pricing column %q", column)
		}
	}
}

func TestFreshCreationSubmissionSchemaHasNoPricingColumns(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:local-schema-no-creation-pricing?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"quote_json", "price_signature", "expires_at"} {
		if db.Migrator().HasColumn(&model.CreationSubmission{}, column) {
			t.Fatalf("creation submission unexpectedly contains pricing column %q", column)
		}
	}
	for _, column := range []string{"execution_json", "config_signature"} {
		if !db.Migrator().HasColumn(&model.CreationSubmission{}, column) {
			t.Fatalf("creation submission is missing local execution column %q", column)
		}
	}
}

func TestLocalSchemaUpgradeMigratesLegacyCreationExecution(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:local-schema-creation-upgrade?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TABLE creation_submissions (
		id TEXT PRIMARY KEY, user_id TEXT, run_id TEXT, item_key TEXT,
		quote_json TEXT, price_signature TEXT, expires_at DATETIME
	)`).Error; err != nil {
		t.Fatal(err)
	}
	legacyQuote := `{"model":"text-test","quoteHash":"stable-config","options":{"maxTokens":128}}`
	if err := db.Exec(`INSERT INTO creation_submissions (id,user_id,run_id,item_key,quote_json,price_signature,expires_at) VALUES (?,?,?,?,?,?,?)`,
		"submission-1", "workspace", "run-1", "item-1", legacyQuote, "legacy-signature", time.Now()).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	var item model.CreationSubmission
	if err := db.First(&item, "id = ?", "submission-1").Error; err != nil {
		t.Fatal(err)
	}
	if item.ConfigSignature != "legacy-signature" || !strings.Contains(item.ExecutionJSON, `"configHash":"stable-config"`) {
		t.Fatalf("legacy execution was not preserved: %#v", item)
	}
	for _, column := range []string{"quote_json", "price_signature", "expires_at"} {
		if db.Migrator().HasColumn("creation_submissions", column) {
			t.Fatalf("legacy creation column %q survived migration", column)
		}
	}
}

func TestFreshLocalSchemaUsesWorkspaceWithoutIdentityTables(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:local-schema-workspace?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if !db.Migrator().HasTable("workspaces") {
		t.Fatal("fresh local schema has no workspace root")
	}
	for _, table := range []string{"users", "auth_sessions", "user_identities", "oauth_states", "email_verification_codes"} {
		if db.Migrator().HasTable(table) {
			t.Fatalf("fresh local schema retained identity table %q", table)
		}
	}
	var count int64
	if err := db.Table("workspaces").Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("workspace count = %d, err = %v", count, err)
	}
}

func TestLocalSchemaUpgradePreservesLegacyOwnerDataWithoutUserRow(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:local-schema-upgrade-workspace?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.Project{}, &model.Resource{}, &model.Task{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := db.Create(&model.User{ID: "legacy-owner", Username: "local", DisplayName: "Local", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Project{ID: "project-1", UserID: "legacy-owner", Name: "Keep me", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Resource{ID: "resource-1", UserID: "legacy-owner", Provider: "local", ObjectKey: "legacy.png", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: "task-1", UserID: "legacy-owner", Type: "image_generation", Status: model.TaskStatusSucceeded, Prompt: "keep", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}

	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	var workspaceID string
	if err := db.Table("workspaces").Select("id").Limit(1).Scan(&workspaceID).Error; err != nil || workspaceID != "legacy-owner" {
		t.Fatalf("workspace id = %q, err = %v", workspaceID, err)
	}
	if db.Migrator().HasTable("users") {
		t.Fatal("legacy users table survived workspace migration")
	}
	for table, id := range map[string]string{"projects": "project-1", "resources": "resource-1", "tasks": "task-1"} {
		var count int64
		if err := db.Table(table).Where("id = ? AND user_id = ?", id, workspaceID).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("%s ownership was not preserved: count=%d err=%v", table, count, err)
		}
	}
}

func TestLocalSchemaUpgradeDropsHostedTablesAndKeepsCoreData(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:local-schema-drop-hosted?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"auth_sessions", "canvas_shares", "user_oss_settings", "billing_orders", "payment_orders", "redeem_codes"} {
		if err := db.Exec("CREATE TABLE " + table + " (id TEXT PRIMARY KEY)").Error; err != nil {
			t.Fatalf("create legacy table %s: %v", table, err)
		}
	}
	if err := db.AutoMigrate(&model.Project{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Project{ID: "project-keep", UserID: "workspace-keep", Name: "Keep", CreatedAt: time.Now(), UpdatedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}

	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"auth_sessions", "canvas_shares", "user_oss_settings", "billing_orders", "payment_orders", "redeem_codes"} {
		if db.Migrator().HasTable(table) {
			t.Fatalf("hosted table %q survived local migration", table)
		}
	}
	var count int64
	if err := db.Model(&model.Project{}).Where("id = ?", "project-keep").Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("core project was not preserved: count=%d err=%v", count, err)
	}
}

func TestTaskDiagnosticsRepairWithOccupiedMigrationVersions(t *testing.T) {
	for _, history := range []string{"agent-v3", "agent-v6"} {
		t.Run(history, func(t *testing.T) {
			db := openHistorical(t, history)
			if err := db.Exec("UPDATE tasks SET id = 'old', error = '历史错误' WHERE id = 'task'").Error; err != nil {
				t.Fatal(err)
			}
			if RequireLocalSchema(db) == nil {
				t.Fatal("missing column reported ready")
			}
			var before localSchemaMigration
			if err := db.First(&before, "version = 3").Error; err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				if err := MigrateLocalSchema(db); err != nil {
					t.Fatal(err)
				}
			}
			status, err := ReadSchemaStatus(db)
			if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
				t.Fatalf("status=%+v error=%v", status, err)
			}
			var migration localSchemaMigration
			if err = db.First(&migration, "version = 3").Error; err != nil || migration.Name != "agent-operation-records" || !migration.AppliedAt.Equal(before.AppliedAt) {
				t.Fatalf("migration overwritten: %+v %v", migration, err)
			}
			var old struct{ Error, PreviewMarker string }
			if err = db.Table("tasks").Where("id = 'old'").Scan(&old).Error; err != nil || old.Error != "历史错误" || old.PreviewMarker != "keep" {
				t.Fatalf("old data lost: %+v %v", old, err)
			}
			mustColumn(t, db, "agent_op_records", "preview_receipt", "keep-receipt")
			for _, kind := range []string{"canvas_text", "image_generate", "video_generate"} {
				if err = db.Create(&model.Task{ID: kind, Type: kind, Prompt: "真实升级回归"}).Error; err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestAssistantTurnsMigrationFromPreviewV9(t *testing.T) {
	db := openHistorical(t, "preview-v9")
	var before []localSchemaMigration
	if err := db.Order("version").Find(&before).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if !db.Migrator().HasTable(&model.AssistantTurn{}) {
		t.Fatal("v10 did not create assistant_turns")
	}
	if !db.Migrator().HasTable(&model.CreationConversation{}) {
		t.Fatal("v11 did not create creation_conversations")
	}
	mustColumn(t, db, "tasks", "preview_marker", "keep")
	var ledger []localSchemaMigration
	if err := db.Order("version").Find(&ledger).Error; err != nil {
		t.Fatal(err)
	}
	if ledger[len(ledger)-1].Version != CurrentSchemaVersion || ledger[len(ledger)-1].Name != "reconcile-preview-assistant-schema" {
		t.Fatalf("current identity: %+v", ledger[len(ledger)-1])
	}
	foundV10 := false
	for _, row := range ledger {
		if row.Version == 10 {
			foundV10 = true
			if row.Name != "assistant-business-turns" {
				t.Fatalf("v10 identity rewritten: %+v", row)
			}
		}
	}
	if !foundV10 {
		t.Fatal("v10 assistant-business-turns missing after v11")
	}
	if !db.Migrator().HasTable(&model.CanvasLibraryFolder{}) || !db.Migrator().HasTable(&model.CanvasDrawing{}) {
		t.Fatal("v12 did not create canvas library tables")
	}
	for i, row := range before {
		if ledger[i].Name != row.Name || !ledger[i].AppliedAt.Equal(row.AppliedAt) {
			t.Fatalf("historical ledger overwritten: %+v", ledger)
		}
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	var again []localSchemaMigration
	if err := db.Order("version").Find(&again).Error; err != nil {
		t.Fatal(err)
	}
	if len(again) != len(ledger) {
		t.Fatalf("idempotent v11 rewrote ledger: %d -> %d", len(ledger), len(again))
	}
}

func TestCreationConversationsMigrationPreservesUnknownColumns(t *testing.T) {
	db := openHistorical(t, "preview-v9")
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("ALTER TABLE creation_conversations ADD COLUMN preview_marker TEXT").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO creation_conversations (user_id, conversation_id, revision, document, deleted, preview_marker, created_at, updated_at)
		VALUES ('local', 'conversation-keep', 1, '{"id":"conversation-keep","title":"历史","messages":[]}', 0, 'keep', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	mustColumn(t, db, "creation_conversations", "preview_marker", "keep")
	var row model.CreationConversation
	if err := db.Where("user_id = ? AND conversation_id = ?", "local", "conversation-keep").First(&row).Error; err != nil {
		t.Fatal(err)
	}
	if row.Revision != 1 || !strings.Contains(row.Document, "conversation-keep") {
		t.Fatalf("v11 rewrote conversation row: %+v", row)
	}
	valid, err := matchesSQLiteIndex(db, sqliteIndexContract{
		table: "creation_conversations", name: "idx_creation_conversations_user_import",
		columns: []string{"user_id", "import_operation_id"}, unique: true, partial: true,
		whereSQL: "import_operation_id IS NOT NULL",
	})
	if err != nil || !valid {
		t.Fatalf("v11 import unique index missing: valid=%v err=%v", valid, err)
	}
}

func TestCreationConversationsImportIndexRepairedWithoutNewMigration(t *testing.T) {
	db := openHistorical(t, "preview-v9")
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("DROP INDEX IF EXISTS idx_creation_conversations_user_import").Error; err != nil {
		t.Fatal(err)
	}
	var ledgerBefore []localSchemaMigration
	if err := db.Order("version").Find(&ledgerBefore).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	valid, err := matchesSQLiteIndex(db, sqliteIndexContract{
		table: "creation_conversations", name: "idx_creation_conversations_user_import",
		columns: []string{"user_id", "import_operation_id"}, unique: true, partial: true,
		whereSQL: "import_operation_id IS NOT NULL",
	})
	if err != nil || !valid {
		t.Fatalf("import unique index not repaired: valid=%v err=%v", valid, err)
	}
	var ledgerAfter []localSchemaMigration
	if err := db.Order("version").Find(&ledgerAfter).Error; err != nil {
		t.Fatal(err)
	}
	if len(ledgerAfter) != len(ledgerBefore) {
		t.Fatalf("repair added a migration: %d -> %d", len(ledgerBefore), len(ledgerAfter))
	}
}
