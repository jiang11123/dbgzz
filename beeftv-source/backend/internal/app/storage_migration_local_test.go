package app

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestLocalStorageMigrationCreatesBackupAndPreservesTask(t *testing.T) {
	dataDir := t.TempDir()
	db, err := database.Open(database.Config{Driver: "sqlite", DataDir: dataDir})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := db.Create(&model.Task{
		ID:        "legacy-local-task",
		UserID:    "local",
		Status:    model.TaskStatusSucceeded,
		Type:      "image",
		Prompt:    "legacy",
		CreatedAt: now,
		UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	svc := NewLocal(repository.New(db), dataDir)
	summary, err := svc.MigrateLegacyStorage()
	if err != nil {
		t.Fatal(err)
	}
	if summary.Backup == "" {
		t.Fatal("local migration did not create a backup")
	}
	task, err := svc.repo.TaskForUser("local", "legacy-local-task")
	if err != nil {
		t.Fatal(err)
	}
	if task.Prompt != "legacy" || task.Status != model.TaskStatusSucceeded {
		t.Fatalf("local task changed during migration: %#v", task)
	}
}
