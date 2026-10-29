package app

import (
	"errors"
	"path/filepath"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestCreateTaskMediaTransportAdmission(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "preflight.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(database.LocalModels()...); err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = svc.Close() })
	request := CreateTaskRequest{Type: "canvas_video", Prompt: "move", Input: map[string]any{
		"mode": "video", "prompt": "move",
		"config":          map[string]any{"interfaceType": "newapi-channel-2", "model": "custom-video", "baseUrl": "https://custom.example/v1", "apiKey": "synthetic-key", "videoGenerateAudio": false},
		"referenceImages": []any{map[string]any{"storageKey": "resource:local-image"}},
	}}
	_, err = svc.CreateTask("user", request)
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Reason != "reference_media_requires_url" {
		t.Fatalf("wrong admission error: %v", err)
	}
	var count int64
	if err := db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("rejected task persisted: %d %v", count, err)
	}
	request.Input["referenceImages"] = []any{map[string]any{"url": "https://cdn.example/image.png"}}
	request.Input["mask"] = map[string]any{"storageKey": "resource:local-mask"}
	if _, err := svc.CreateTask("user", request); !errors.As(err, &appErr) || appErr.Reason != "reference_media_requires_url" {
		t.Fatalf("mask-only rejection missing: %v", err)
	}
	if err := db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("mask rejection persisted: %d %v", count, err)
	}
	request.Input["mask"] = map[string]any{"url": "https://cdn.example/mask.png"}
	task, err := svc.CreateTask("user", request)
	if err != nil || task.Status != model.TaskStatusQueued {
		t.Fatalf("HTTPS task not accepted: %v", err)
	}
}

func TestTaskCapabilityInvalidConfigDoesNotSkipValidation(t *testing.T) {
	svc := &Service{}
	if err := svc.ValidateTaskCapability(map[string]any{"mode": "video", "config": map[string]any{"videoGenerateAudio": map[string]any{"bad": true}}}); err == nil {
		t.Fatal("malformed configuration skipped validation")
	}
}
