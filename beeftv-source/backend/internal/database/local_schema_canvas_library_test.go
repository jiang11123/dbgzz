package database

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestCanvasLibrarySchemaMigratesHistoricalLayouts(t *testing.T) {
	for _, history := range []string{"product-v2", "product-v3", "agent-v6", "preview-v8", "preview-v9"} {
		t.Run(history, func(t *testing.T) {
			db := openHistorical(t, history)
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
			mustColumn(t, db, "tasks", "preview_marker", "keep")
			if !db.Migrator().HasTable(&model.CanvasLibraryFolder{}) || !db.Migrator().HasTable(&model.CanvasDrawing{}) {
				t.Fatal("v12 did not create canvas library tables")
			}
			for _, column := range []string{"deleted_at", "cover_resource_id"} {
				has, err := sqliteHasColumn(db, "canvas_library_folders", column)
				if err != nil || !has {
					t.Fatalf("folders.%s missing: %v", column, err)
				}
			}
			for _, column := range []string{"deleted_at", "snapshot_json", "preview_resource_id", "render_resource_id"} {
				has, err := sqliteHasColumn(db, "canvas_drawings", column)
				if err != nil || !has {
					t.Fatalf("drawings.%s missing: %v", column, err)
				}
			}
			hasFolder, err := sqliteHasColumn(db, "canvas_projects", "library_folder_id")
			if err != nil || !hasFolder {
				t.Fatalf("canvas_projects.library_folder_id missing: %v", err)
			}
			var ledger []localSchemaMigration
			if err := db.Order("version").Find(&ledger).Error; err != nil {
				t.Fatal(err)
			}
			last := ledger[len(ledger)-1]
			if last.Version != CurrentSchemaVersion {
				t.Fatalf("current schema identity: %+v", last)
			}
			var canvasMigration localSchemaMigration
			if err := db.First(&canvasMigration, "version = ?", 12).Error; err != nil || canvasMigration.Name != "canvas-library-drawings" {
				t.Fatalf("v12 identity: %+v, err = %v", canvasMigration, err)
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
				t.Fatalf("idempotent v12 rewrote ledger: %d -> %d", len(ledger), len(again))
			}
		})
	}
}

func TestCanvasLibrarySchemaCrashRetryKeepsUnknownColumns(t *testing.T) {
	db := openHistorical(t, "preview-v9")
	if err := db.Exec("ALTER TABLE canvas_projects ADD COLUMN preview_library_note TEXT").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO canvas_projects(id,user_id,title,payload_json,revision,preview_library_note,created_at,updated_at)
		VALUES ('canvas','owner','keep','{}',1,'keep',datetime('now'),datetime('now'))`).Error; err != nil {
		t.Fatal(err)
	}
	injected := errors.New("injected canvas library migration failure")
	err := migrateLocalSchema(db, func(version int64) error {
		if version == 12 {
			return injected
		}
		return nil
	})
	if !errors.Is(err, injected) {
		t.Fatalf("migration error = %v, want injected failure", err)
	}
	version, err := currentSchemaVersion(db)
	if err != nil || version != 11 {
		t.Fatalf("version after v12 failure = %d, err = %v", version, err)
	}
	if db.Migrator().HasTable(&model.CanvasDrawing{}) {
		t.Fatal("failed v12 created canvas drawings before commit")
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	version, err = currentSchemaVersion(db)
	if err != nil || version != CurrentSchemaVersion {
		t.Fatalf("retry version = %d err = %v", version, err)
	}
	mustColumn(t, db, "tasks", "preview_marker", "keep")
	mustColumn(t, db, "canvas_projects", "preview_library_note", "keep")
	hasDeleted, err := sqliteHasColumn(db, "canvas_drawings", "deleted_at")
	if err != nil || !hasDeleted {
		t.Fatalf("retry missing drawings.deleted_at: %v", err)
	}
}
