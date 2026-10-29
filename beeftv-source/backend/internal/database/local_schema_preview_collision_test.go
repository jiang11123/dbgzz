package database

import (
	"errors"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestPreviewWorkflowLedgerCollisionReconcilesAssistantSchema(t *testing.T) {
	db, err := Open(Config{DSN: "file:preview-workflow-ledger-collision?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := ConfigurePool(db); err != nil {
		t.Fatal(err)
	}
	raw, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()

	stop := errors.New("stop before v17")
	if err := migrateLocalSchema(db, func(version int64) error {
		if version == 17 {
			return stop
		}
		return nil
	}); !errors.Is(err, stop) {
		t.Fatalf("prepare legacy schema: %v", err)
	}

	workflow := model.CanvasWorkflow{ID: "legacy-workflow", UserID: "local", Name: "Keep me", DefinitionJSON: `{"version":1}`, RecipeCipher: "legacy-cipher"}
	if err := db.Create(&workflow).Error; err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"assistant_skill_context_mutations", "assistant_skill_contexts", "assistant_continuations"} {
		if err := db.Migrator().DropTable(table); err != nil {
			t.Fatalf("drop %s: %v", table, err)
		}
	}
	if err := db.Exec("ALTER TABLE assistant_turns DROP COLUMN continuation_invalidated").Error; err != nil {
		t.Fatal(err)
	}

	legacyAppliedAt := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	for _, row := range []localSchemaMigration{
		{Version: 17, Name: "canvas-reusable-workflows", AppliedAt: legacyAppliedAt},
		{Version: 18, Name: "canvas-workflow-source-snapshots", AppliedAt: legacyAppliedAt},
		{Version: 19, Name: "canvas-workflow-immutable-revisions", AppliedAt: legacyAppliedAt},
	} {
		if err := db.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}

	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"assistant_skill_contexts", "assistant_skill_context_mutations", "assistant_continuations"} {
		if !db.Migrator().HasTable(table) {
			t.Fatalf("missing reconciled table %s", table)
		}
	}
	for _, column := range []string{"continuation_invalidated", "generation_authorization_json"} {
		if !db.Migrator().HasColumn("assistant_turns", column) {
			t.Fatalf("missing reconciled assistant_turns column %s", column)
		}
	}
	var preserved model.CanvasWorkflow
	if err := db.First(&preserved, "id = ?", workflow.ID).Error; err != nil {
		t.Fatal(err)
	}
	if preserved.Name != workflow.Name || preserved.DefinitionJSON != workflow.DefinitionJSON || preserved.RecipeCipher != workflow.RecipeCipher {
		t.Fatalf("legacy workflow changed: %+v", preserved)
	}
	var legacyRows []localSchemaMigration
	if err := db.Where("version BETWEEN 17 AND 19").Order("version").Find(&legacyRows).Error; err != nil {
		t.Fatal(err)
	}
	if len(legacyRows) != 3 || legacyRows[0].Name != "canvas-reusable-workflows" || legacyRows[2].Name != "canvas-workflow-immutable-revisions" || !legacyRows[0].AppliedAt.Equal(legacyAppliedAt) {
		t.Fatalf("legacy migration ledger changed: %+v", legacyRows)
	}
}
