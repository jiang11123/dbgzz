package app

import (
	"errors"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func TestGeneratedMediaIngestDiskFullReturnsStructuredFailure(t *testing.T) {
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "ingest-full.db"), t.TempDir())
	defer closeDB(t, db)
	if err := db.Callback().Create().Before("gorm:create").Register("test:resource-disk-full", func(tx *gorm.DB) {
		if tx.Statement.Table == "resources" {
			tx.AddError(syscall.ENOSPC)
		}
	}); err != nil {
		t.Fatal(err)
	}
	_, err := svc.persistTaskGeneratedMediaResult(model.Task{ID: "task-full", UserID: "user-1"}, map[string]interface{}{
		"image": map[string]interface{}{"dataUrl": tinyPNGDataURL},
	})
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Reason != "local_disk_full" || !errors.Is(err, syscall.ENOSPC) {
		t.Fatalf("ingest failure lost disk-full evidence: %v", err)
	}
}

func TestGeneratedMediaIngestFailureDoesNotCompleteBindOrPost(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ingest-fail.db")
	svc, db := newGenerationDeliveryMediaService(t, path, t.TempDir())
	defer closeDB(t, db)
	media := &deliveryMediaStub{resource: &model.Resource{ID: "should-not-persist"}}
	svc.generationDeliveryMedia = media
	now := time.Now()
	task := model.Task{
		ID: "task-running-ingest", UserID: "user-1", Type: "canvas_image",
		Status: model.TaskStatusRunning, Prompt: "cat", CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	_, err := svc.persistGeneratedMediaResult("user-1", map[string]interface{}{
		"content": "data:video/mp4;base64,broken",
	})
	if err == nil {
		t.Fatal("invalid data URL succeeded")
	}
	if media.persists.Load() != 0 {
		t.Fatalf("ingest posted a remote artifact persist = %d", media.persists.Load())
	}
	var got model.Task
	if err := db.First(&got, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if got.Status != model.TaskStatusRunning || strings.TrimSpace(got.ResultJSON) != "" {
		t.Fatalf("ingest failure mutated task: %#v", got)
	}
	var results, representations int64
	if err := db.Model(&model.Result{}).Where("kind = ?", localtask.ResultKindGenerationOutput).Count(&results).Error; err != nil || results != 0 {
		t.Fatalf("generation results = %d err=%v", results, err)
	}
	if err := db.Model(&model.AssetRepresentation{}).Count(&representations).Error; err != nil || representations != 0 {
		t.Fatalf("representations = %d err=%v", representations, err)
	}
}

func TestGeneratedMediaIngestSuccessLeavesTaskUnbound(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ingest-success.db")
	svc, db := newGenerationDeliveryMediaService(t, path, t.TempDir())
	defer closeDB(t, db)
	media := &deliveryMediaStub{resource: &model.Resource{ID: "should-not-persist"}}
	svc.generationDeliveryMedia = media
	now := time.Now()
	task := model.Task{
		ID: "task-running-ok", UserID: "user-1", Type: "canvas_image",
		Status: model.TaskStatusRunning, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	result, err := svc.persistGeneratedMediaResult("user-1", map[string]interface{}{
		"image": map[string]interface{}{"dataUrl": tinyPNGDataURL},
	})
	if err != nil {
		t.Fatal(err)
	}
	image := result["image"].(map[string]interface{})
	if !strings.HasPrefix(stringField(image, "storageKey"), "resource:") {
		t.Fatalf("stored = %#v", image)
	}
	if media.persists.Load() != 0 {
		t.Fatalf("first-stage ingest called remote persist = %d", media.persists.Load())
	}
	var got model.Task
	if err := db.First(&got, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if got.Status != model.TaskStatusRunning {
		t.Fatalf("ingest completed the task: %s", got.Status)
	}
	var representations int64
	if err := db.Model(&model.AssetRepresentation{}).Count(&representations).Error; err != nil || representations != 0 {
		t.Fatalf("ingest bound representations = %d err=%v", representations, err)
	}
}

func TestGeneratedMediaIngestTaskRecoversSameIdentityAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ingest-identity.db")
	dataDir := t.TempDir()
	svc, db := newGenerationDeliveryMediaService(t, path, dataDir)
	input := map[string]interface{}{"image": map[string]interface{}{"dataUrl": tinyPNGDataURL}}
	task := model.Task{ID: "task-identity", UserID: "user-1"}
	first, err := svc.persistTaskGeneratedMediaResult(task, input)
	if err != nil {
		t.Fatal(err)
	}
	firstID := stringField(first["image"].(map[string]interface{}), "resourceId")
	closeDB(t, db)
	svc, db = newGenerationDeliveryMediaService(t, path, dataDir)
	defer closeDB(t, db)
	second, err := svc.persistTaskGeneratedMediaResult(task, input)
	if err != nil {
		t.Fatal(err)
	}
	secondID := stringField(second["image"].(map[string]interface{}), "resourceId")
	if firstID == "" || firstID != secondID {
		t.Fatalf("identity reuse %q vs %q", firstID, secondID)
	}
	var count int64
	if err := db.Model(&model.Resource{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("resources = %d err=%v", count, err)
	}
}
