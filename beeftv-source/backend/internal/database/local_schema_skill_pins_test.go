package database

import (
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"path/filepath"
	"testing"
)

func TestV13WorkspaceSkillPinMigrationPreservesRounds(t *testing.T) {
	file := filepath.Join(t.TempDir(), "v13-copy.sqlite")
	db, err := gorm.Open(sqlite.Open(file), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	// A complete occupied v13 copy, not a reduced synthetic turn table.
	if err := db.Exec("DELETE FROM local_schema_migrations WHERE version >= 14").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("ALTER TABLE assistant_turns DROP COLUMN skill_pins_json").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("ALTER TABLE assistant_turns ADD COLUMN private_preview_note TEXT").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO assistant_turns(turn_id,user_id,canvas_id,state,document,private_preview_note) VALUES('aaaaaaaabbbbbbbb','local','canvas','open','{"nodes":[]}','keep')`).Error; err != nil {
		t.Fatal(err)
	}
	var before []localSchemaMigration
	db.Order("version").Find(&before)
	sqlDB, _ := db.DB()
	sqlDB.Close()
	db, err = gorm.Open(sqlite.Open(file), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ = db.DB()
	defer sqlDB.Close()
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	var turn model.AssistantTurn
	if err := db.First(&turn, "turn_id = ?", "aaaaaaaabbbbbbbb").Error; err != nil {
		t.Fatal(err)
	}
	if turn.State != "open" || turn.Document != `{"nodes":[]}` || turn.SkillPinsJSON != "" {
		t.Fatalf("round changed: %+v", turn)
	}
	var note string
	db.Raw("SELECT private_preview_note FROM assistant_turns").Scan(&note)
	if note != "keep" {
		t.Fatal("unknown column lost")
	}
	var after []localSchemaMigration
	db.Order("version").Find(&after)
	if len(after) != len(canonicalLocalMigrations()) {
		t.Fatalf("ledger=%+v", after)
	}
	for i, migration := range canonicalLocalMigrations() {
		if after[i].Version != migration.version || after[i].Name != migration.name {
			t.Fatalf("migration %d changed: %+v", i, after[i])
		}
	}
	for i, row := range before {
		if row.Name != after[i].Name || !row.AppliedAt.Equal(after[i].AppliedAt) {
			t.Fatal("historical ledger changed")
		}
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	db.Exec("ALTER TABLE assistant_turns DROP COLUMN skill_pins_json")
	if err := RequireLocalSchema(db); err == nil {
		t.Fatal("v14 missing pin column accepted")
	}
}
