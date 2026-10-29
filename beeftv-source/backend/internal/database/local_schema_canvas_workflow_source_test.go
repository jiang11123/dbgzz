package database

import (
	"errors"
	"infinite-canvas/backend/internal/model"
	"testing"
)

func TestCanvasWorkflowSourceMigrationFromV21PreservesHistory(t *testing.T) {
	db, err := Open(Config{DSN: "file:canvas-workflow-source-v21?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	stop := errors.New("stop at historical v21")
	if err = migrateLocalSchema(db, func(version int64) error {
		if version == 22 {
			return stop
		}
		return nil
	}); !errors.Is(err, stop) {
		t.Fatalf("setup=%v", err)
	}
	if db.Migrator().HasColumn(&model.Task{}, "workflow_source_cipher") {
		if err = db.Exec("ALTER TABLE tasks DROP COLUMN workflow_source_cipher").Error; err != nil {
			t.Fatal(err)
		}
	}
	if err = db.Exec(`INSERT INTO tasks(id,user_id,type,status,input_json) VALUES ('historical','owner','canvas_image','succeeded','{"mode":"image"}')`).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Create(&model.CanvasWorkflow{ID: "legacy", UserID: "owner", Name: "Old", DefinitionJSON: `{"version":1}`, RecipeCipher: "unchanged-cipher"}).Error; err != nil {
		t.Fatal(err)
	}
	if err = MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	var source model.Task
	if err = db.First(&source, "id = ?", "historical").Error; err != nil {
		t.Fatal(err)
	}
	if source.InputJSON != `{"mode":"image"}` || source.WorkflowSourceCipher != "" {
		t.Fatal("migration invented or rewrote historical source")
	}
	var revision model.CanvasWorkflowRevision
	if err = db.First(&revision, "template_id = ? AND revision = ?", "legacy", 1).Error; err != nil || revision.RecipeCipher != "unchanged-cipher" || revision.DefinitionJSON != `{"version":1}` {
		t.Fatalf("legacy revision changed: %+v %v", revision, err)
	}
	version, err := currentSchemaVersion(db)
	if err != nil || version != CurrentSchemaVersion {
		t.Fatalf("version=%d err=%v", version, err)
	}
}
