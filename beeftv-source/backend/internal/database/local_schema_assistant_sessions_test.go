package database

import (
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"path/filepath"
	"testing"
)

func TestV16SessionMigrationPreservesV15RoundAndUnknownColumns(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "v15.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sql, _ := db.DB()
	defer sql.Close()
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"DELETE FROM local_schema_migrations WHERE version>=16", "ALTER TABLE assistant_turns DROP COLUMN durable_session_id", "ALTER TABLE assistant_turns DROP COLUMN durable_native_sources", "ALTER TABLE assistant_turns ADD COLUMN private_note TEXT", `INSERT INTO assistant_turns(turn_id,user_id,canvas_id,state,permission_mode,document,private_note) VALUES('abcd1234','owner','canvas','open','read-only','{"nodes":[]}','keep')`} {
		if err := db.Exec(query).Error; err != nil {
			t.Fatal(err)
		}
	}
	var before []localSchemaMigration
	db.Order("version").Find(&before)
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	var row model.AssistantTurn
	if err := db.First(&row, "turn_id = ?", "abcd1234").Error; err != nil {
		t.Fatal(err)
	}
	if row.PermissionMode != "read-only" || row.State != "open" || row.Document != `{"nodes":[]}` || row.DurableSessionID != "" || row.DurableNativeSources != "" {
		t.Fatalf("legacy round changed: %+v", row)
	}
	var note string
	db.Raw("SELECT private_note FROM assistant_turns").Scan(&note)
	if note != "keep" {
		t.Fatal("unknown field removed")
	}
	var after []localSchemaMigration
	db.Order("version").Find(&after)
	if len(after) != len(canonicalLocalMigrations()) {
		t.Fatal("migration ledger count")
	}
	for i, v := range before {
		if v.Name != after[i].Name || !v.AppliedAt.Equal(after[i].AppliedAt) {
			t.Fatal("old migration ledger changed")
		}
	}
	if err := db.Exec("ALTER TABLE assistant_turns DROP COLUMN durable_native_sources").Error; err != nil {
		t.Fatal(err)
	}
	if RequireLocalSchema(db) == nil {
		t.Fatal("missing exact source column accepted")
	}
}
