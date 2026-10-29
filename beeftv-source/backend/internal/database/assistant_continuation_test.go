package database

import (
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/model"
	"path/filepath"
	"testing"
)

func TestContinuationMigrationPreservesHistoryAndChecksReceiptStructure(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "v17.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sql, _ := db.DB()
	defer sql.Close()
	if err = MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err = db.Migrator().DropTable(&model.AssistantContinuation{}); err != nil {
		t.Fatal(err)
	}
	if err = db.Exec("DELETE FROM local_schema_migrations WHERE version >= 18").Error; err != nil {
		t.Fatal(err)
	}
	var before []localSchemaMigration
	db.Order("version").Find(&before)
	if err = db.Create(&model.AssistantTurn{TurnID: "aabbccdd", UserID: "local", CanvasID: "canvas", State: "settled"}).Error; err != nil {
		t.Fatal(err)
	}
	if err = MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err = RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err = MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	var after []localSchemaMigration
	db.Order("version").Find(&after)
	if len(after) != len(before)+8 || after[len(before)].Name != "assistant-generation-continuations" || after[len(before)+1].Name != "assistant-continuation-intent-fence" || after[len(before)+2].Name != "assistant-production-authorization" || after[len(before)+3].Name != "skill-market-release-metadata" || after[len(before)+7].Name != "reconcile-preview-assistant-schema" {
		t.Fatal("migration identity")
	}
	for i, row := range before {
		if row.Name != after[i].Name || !row.AppliedAt.Equal(after[i].AppliedAt) {
			t.Fatal("historical ledger changed")
		}
	}
	var turn model.AssistantTurn
	if err = db.First(&turn, "turn_id = ?", "aabbccdd").Error; err != nil || turn.State != "settled" {
		t.Fatal("history changed", err)
	}
	if err = db.Exec("ALTER TABLE assistant_continuations DROP COLUMN manifest_json").Error; err != nil {
		t.Fatal(err)
	}
	if RequireLocalSchema(db) == nil {
		t.Fatal("missing manifest accepted as ready")
	}
}

func TestContinuationIntentFenceMigrationPreservesV18History(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "v18.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sql, _ := db.DB()
	defer sql.Close()
	if err = MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err = db.Create(&model.AssistantTurn{TurnID: "old", UserID: "local", CanvasID: "canvas", State: "settled"}).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec("ALTER TABLE assistant_turns DROP COLUMN continuation_invalidated").Error; err != nil {
		t.Fatal(err)
	}
	if RequireLocalSchema(db) == nil {
		t.Fatal("missing fence accepted")
	}
	if err = db.Exec("DELETE FROM local_schema_migrations WHERE version >= 19").Error; err != nil {
		t.Fatal(err)
	}
	var before []localSchemaMigration
	db.Order("version").Find(&before)
	if err = MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	var turn model.AssistantTurn
	if err = db.First(&turn, "turn_id = ?", "old").Error; err != nil || turn.State != "settled" || turn.ContinuationInvalidated {
		t.Fatal("old history damaged", turn, err)
	}
	if err = db.Model(&turn).Update("continuation_invalidated", true).Error; err != nil {
		t.Fatal(err)
	}
	if err = MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err = db.First(&turn, "turn_id = ?", "old").Error; err != nil || !turn.ContinuationInvalidated {
		t.Fatal("migration reset revocation", err)
	}
	var after []localSchemaMigration
	db.Order("version").Find(&after)
	if len(after) != len(before)+7 || after[len(before)].Name != "assistant-continuation-intent-fence" || after[len(before)+1].Name != "assistant-production-authorization" || after[len(before)+2].Name != "skill-market-release-metadata" || after[len(before)+6].Name != "reconcile-preview-assistant-schema" {
		t.Fatal("migration identity")
	}
	for i, row := range before {
		if row.Name != after[i].Name || !row.AppliedAt.Equal(after[i].AppliedAt) {
			t.Fatal("old ledger changed")
		}
	}
}
