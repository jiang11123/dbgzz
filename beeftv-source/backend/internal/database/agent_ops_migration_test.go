package database_test

import (
	"context"
	"path/filepath"
	"testing"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
)

func TestVersionTwoWorkspaceAddsDurableAgentOperations(t *testing.T) {
	config := database.Config{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "existing-v2.db")}
	db, err := database.Open(config)
	if err != nil {
		t.Fatal(err)
	}
	// Reproduce an installed v2 database, without creating the new table first.
	for _, entry := range database.LocalModels() {
		if _, added := entry.(*model.AgentOpRecord); added {
			continue
		}
		if err := db.AutoMigrate(entry); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Exec(`CREATE TABLE local_schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at DATETIME)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO local_schema_migrations (version,name) VALUES (1,'local-core-schema'),(2,'retire-hosted-schema')`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Project{ID: "existing", UserID: "owner", Name: "preserve"}).Error; err != nil {
		t.Fatal(err)
	}
	if db.Migrator().HasTable(&model.AgentOpRecord{}) {
		t.Fatal("v2 fixture already has agent operations")
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if !db.Migrator().HasTable(&model.AgentOpRecord{}) {
		t.Fatal("upgraded v2 workspace lacks agent_op_records")
	}
	if err := database.RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	fn := func(tx *gorm.DB) ([]byte, error) {
		if err := tx.Create(&model.Project{ID: "created-once", UserID: "owner", Name: "new"}).Error; err != nil {
			return nil, err
		}
		return []byte(`{"id":"created-once"}`), nil
	}
	first, err := agentops.NewStore(db).Run(context.Background(), agentops.RunRequest{UserID: "owner", OpID: "operation-1", Op: "project.create", PayloadHash: "hash"}, fn)
	if err != nil || first.Replayed {
		t.Fatalf("first write: %+v, %v", first, err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = database.Open(config)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err = db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	replay, err := agentops.NewStore(db).Run(context.Background(), agentops.RunRequest{UserID: "owner", OpID: "operation-1", Op: "project.create", PayloadHash: "hash"}, fn)
	if err != nil || !replay.Replayed || string(replay.Result) != string(first.Result) {
		t.Fatalf("durable replay: %+v, %v", replay, err)
	}
	var count int64
	if err := db.Model(&model.Project{}).Count(&count).Error; err != nil || count != 2 {
		t.Fatalf("projects changed: %d %v", count, err)
	}
	var existing model.Project
	if err := db.First(&existing, "id = ?", "existing").Error; err != nil || existing.Name != "preserve" {
		t.Fatalf("old project changed: %+v %v", existing, err)
	}
	if err := db.Table("local_schema_migrations").Where("version = ?", 3).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("migration not recorded once: %d %v", count, err)
	}
}
