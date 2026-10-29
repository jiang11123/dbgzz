package database

import (
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"path/filepath"
	"testing"
)

func TestV14PermissionMigrationPreservesOpenTurnAndUnknownColumns(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "v14.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sql, _ := db.DB()
	defer sql.Close()
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"DELETE FROM local_schema_migrations WHERE version>=15", "ALTER TABLE assistant_turns DROP COLUMN permission_mode", "ALTER TABLE assistant_turns DROP COLUMN canvas_snapshots_json", "ALTER TABLE assistant_turns ADD COLUMN private_preview_note TEXT", `INSERT INTO assistant_turns(turn_id,user_id,canvas_id,state,document,private_preview_note) VALUES('aabbccdd','owner','canvas','open','{"nodes":[]}','keep')`} {
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
	if err := db.First(&row, "turn_id = ?", "aabbccdd").Error; err != nil {
		t.Fatal(err)
	}
	if row.State != "open" || row.Document != `{"nodes":[]}` || row.PermissionMode != "" || row.CanvasSnapshotsJSON != "" {
		t.Fatalf("old round modified: %+v", row)
	}
	var note string
	db.Raw("SELECT private_preview_note FROM assistant_turns").Scan(&note)
	if note != "keep" {
		t.Fatal("unknown column removed")
	}
	var after []localSchemaMigration
	db.Order("version").Find(&after)
	if len(after) != len(canonicalLocalMigrations()) {
		t.Fatal("ledger count")
	}
	for i, v := range before {
		if v.Name != after[i].Name || !v.AppliedAt.Equal(after[i].AppliedAt) {
			t.Fatal("historical ledger changed")
		}
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("ALTER TABLE assistant_turns DROP COLUMN permission_mode").Error; err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err == nil {
		t.Fatal("v15 missing permission column accepted")
	}
}
