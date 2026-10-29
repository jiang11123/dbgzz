package database

import (
	"path/filepath"
	"reflect"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func TestV20MarketReleaseMigrationPreservesVersionsAndLedger(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "v20.sqlite")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := db.DB()
	defer raw.Close()
	if err := ConfigurePool(db); err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{
		"DELETE FROM local_schema_migrations WHERE version >= 21",
		"ALTER TABLE skill_versions DROP COLUMN market_release_json",
		"ALTER TABLE skill_versions ADD COLUMN private_preview_note TEXT",
		"INSERT INTO skill_versions(id,skill_id,version_label,content_hash,entry_path,package_key,file_count,total_bytes,source_commit,private_preview_note) VALUES('version','skill','1','hash','SKILL.md','skill/version.zip',1,42,'commit','keep')",
	} {
		if err := db.Exec(sql).Error; err != nil {
			t.Fatal(err)
		}
	}
	var before []localSchemaMigration
	if err := db.Order("version").Find(&before).Error; err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err == nil {
		t.Fatal("v20 accepted before migration")
	}
	for i := 0; i < 2; i++ {
		if err := MigrateLocalSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	if err := RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	var version model.SkillVersion
	if err := db.First(&version, "id = ?", "version").Error; err != nil {
		t.Fatal(err)
	}
	if version.ContentHash != "hash" || version.PackageKey != "skill/version.zip" || version.SourceCommit != "commit" || version.MarketReleaseJSON != "" {
		t.Fatalf("historical version changed: %+v", version)
	}
	var note string
	if err := db.Raw("SELECT private_preview_note FROM skill_versions WHERE id = 'version'").Scan(&note).Error; err != nil || note != "keep" {
		t.Fatal("unknown column lost", err)
	}
	var after []localSchemaMigration
	if err := db.Order("version").Find(&after).Error; err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before)+5 || !reflect.DeepEqual(before, after[:len(before)]) || after[len(before)].Version != 21 || after[len(before)].Name != "skill-market-release-metadata" || after[len(before)+4].Name != "reconcile-preview-assistant-schema" {
		t.Fatalf("migration ledger changed: %+v", after)
	}
	if err := db.Exec("ALTER TABLE skill_versions DROP COLUMN market_release_json").Error; err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err == nil {
		t.Fatal("v21 accepted with missing market metadata column")
	}
}
