package asset

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newDeletionDomain(t *testing.T) (*Service, *gorm.DB, string) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared&_busy_timeout=5000"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	repo := repository.New(db)
	svc := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      nopQuota{},
		Lifecycle:  nopLifecycle{},
	})
	return svc, db, dataDir
}

func TestOccupiedMessageNamesBusinessRecord(t *testing.T) {
	message := OccupiedMessage([]ResourceUsage{
		{Kind: "画布", ID: "canvas-1", Title: "广告分镜"},
		{Kind: "画布", ID: "canvas-1", Title: "广告分镜"},
	})
	if !strings.Contains(message, "画布「广告分镜」") || !strings.Contains(message, "解除引用") {
		t.Fatalf("message = %q", message)
	}
}

func TestDeleteLocalObjectRemovesOnlyResourceDirectoryFile(t *testing.T) {
	dataDir := t.TempDir()
	resourcePath := filepath.Join(dataDir, "resources", "users", "user-1", "image", "asset.png")
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	svc := NewService(Dependencies{Blobs: NewFileStore(dataDir)})
	if err := svc.DeleteLocalObject("users/user-1/image/asset.png"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(resourcePath); !os.IsNotExist(err) {
		t.Fatalf("resource file still exists: %v", err)
	}
	outsidePath := filepath.Join(dataDir, "outside.txt")
	if err := os.WriteFile(outsidePath, []byte("keep"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteLocalObject("../outside.txt"); err == nil {
		t.Fatal("path traversal should be rejected")
	}
	if _, err := os.Stat(outsidePath); err != nil {
		t.Fatalf("outside file was changed: %v", err)
	}
}

func TestDeleteAssetKeepsLiveCanvasResource(t *testing.T) {
	svc, db, _ := newDeletionDomain(t)
	resource := model.Resource{ID: "resource-canvas", UserID: "user-1", Provider: "local", ObjectKey: "users/user-1/image/canvas.png", Status: model.ResourceStatusReady}
	asset := model.Asset{ID: "asset-canvas", UserID: "user-1", Title: "画布素材", PayloadJSON: `{"data":{"storageKey":"resource:resource-canvas"}}`}
	canvas := model.CanvasProject{ID: "canvas-live", UserID: "user-1", Title: "仍在使用的画布", PayloadJSON: `{"nodes":[{"data":{"storageKey":"resource:resource-canvas"}}]}`}
	for _, item := range []any{&resource, &asset, &canvas} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.DeleteUserAssetWithResources("user-1", asset.ID); err != nil {
		t.Fatalf("DeleteUserAssetWithResources() error = %v", err)
	}
	var assetCount, resourceCount int64
	if err := db.Model(&model.Asset{}).Where("id = ?", asset.ID).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Count(&resourceCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 0 || resourceCount != 1 {
		t.Fatalf("delete must retain referenced resource: asset=%d resource=%d", assetCount, resourceCount)
	}
}

func TestDeletionWorkerRemovesObjectAndCompletesOutbox(t *testing.T) {
	svc, db, dataDir := newDeletionDomain(t)
	objectKey := "users/user-1/image/queued.png"
	resourcePath := filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	job := model.ResourceDeletionJob{
		ID: "deletion-1", UserID: "user-1", ResourceID: "resource-1",
		Provider: "local", ObjectKey: objectKey,
		Status: model.ResourceDeletionStatusPending, NextAttemptAt: time.Now().Add(-time.Second),
	}
	if err := db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	svc.DrainDeletionJobs(1)
	if _, err := os.Stat(resourcePath); !os.IsNotExist(err) {
		t.Fatalf("queued physical object was not deleted: %v", err)
	}
	var count int64
	if err := db.Model(&model.ResourceDeletionJob{}).Where("id = ?", job.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("completed deletion job was not removed")
	}
}

func TestDetachedCleanupKeepsReferencedResource(t *testing.T) {
	svc, db, _ := newDeletionDomain(t)
	old := time.Now().Add(-48 * time.Hour)
	orphan := model.Resource{
		ID: "resource-detached", UserID: "user-1", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/detached.png",
		CreatedAt: old, UpdatedAt: old,
	}
	backed := model.Resource{
		ID: "resource-backed", UserID: "user-1", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/backed.png",
		CreatedAt: old, UpdatedAt: old,
	}
	asset := model.Asset{
		ID: "asset-backed", UserID: "user-1", Title: "素材库图片",
		PayloadJSON: `{"data":{"storageKey":"resource:resource-backed"}}`, CreatedAt: old, UpdatedAt: old,
	}
	for _, item := range []any{&orphan, &backed, &asset} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.CleanupDetachedUserResources("user-1", []model.Resource{orphan, backed}); err != nil {
		t.Fatal(err)
	}
	var orphanCount, backedCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", orphan.ID).Count(&orphanCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Resource{}).Where("id = ?", backed.ID).Count(&backedCount).Error; err != nil {
		t.Fatal(err)
	}
	if orphanCount != 0 || backedCount != 1 {
		t.Fatalf("cleanup result: orphan=%d backed=%d", orphanCount, backedCount)
	}
}

func TestDeleteStoredObjectRejectsForeignOwnerForgedIdentity(t *testing.T) {
	svc, db, dataDir := newDeletionDomain(t)
	objectKey := "users/user-1/image/owned.png"
	resourcePath := filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{
		ID: "resource-owned", UserID: "user-1", Provider: "local", ObjectKey: objectKey,
		Status: model.ResourceStatusReady,
	}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	forged := &model.Resource{
		ID: resource.ID, UserID: "user-2", Provider: "local",
		ObjectKey: objectKey, Status: model.ResourceStatusReady,
	}
	if err := svc.DeleteStoredObject("user-2", forged); err == nil {
		t.Fatal("foreign delete succeeded")
	}
	if _, err := os.Stat(resourcePath); err != nil {
		t.Fatalf("owned file was removed: %v", err)
	}
	missing := &model.Resource{
		ID: "missing-id", UserID: "user-2", Provider: "local", ObjectKey: objectKey,
	}
	if err := svc.DeleteStoredObject("user-2", missing); err == nil {
		t.Fatal("missing-id delete succeeded")
	}
	if _, err := os.Stat(resourcePath); err != nil {
		t.Fatalf("owned file was removed via missing id: %v", err)
	}
}

func TestDeleteStoredObjectUsesPersistedObjectKey(t *testing.T) {
	svc, db, dataDir := newDeletionDomain(t)
	ownedKey := "users/user-1/image/owned.png"
	decoyKey := "users/user-1/image/decoy.png"
	for _, key := range []string{ownedKey, decoyKey} {
		path := filepath.Join(dataDir, "resources", filepath.FromSlash(key))
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(key), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	resource := model.Resource{
		ID: "resource-persisted", UserID: "user-1", Provider: "local", ObjectKey: ownedKey,
		Status: model.ResourceStatusReady,
	}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	forged := &model.Resource{
		ID: resource.ID, UserID: "user-1", Provider: "local", ObjectKey: decoyKey,
	}
	if err := svc.DeleteStoredObject("user-1", forged); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "resources", filepath.FromSlash(ownedKey))); !os.IsNotExist(err) {
		t.Fatalf("persisted object still exists: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "resources", filepath.FromSlash(decoyKey))); err != nil {
		t.Fatalf("forged object key was deleted: %v", err)
	}
}

func TestDeleteAssetAndResourcesAbortsWhenLiveCanvasAppears(t *testing.T) {
	_, db, dataDir := newDeletionDomain(t)
	objectKey := "users/user-1/image/live.png"
	resourcePath := filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "resource-live", UserID: "user-1", Provider: "local", ObjectKey: objectKey, Status: model.ResourceStatusReady}
	asset := model.Asset{ID: "asset-live", UserID: "user-1", Title: "素材", PayloadJSON: `{"data":{"storageKey":"resource:resource-live"}}`}
	canvas := model.CanvasProject{ID: "canvas-live", UserID: "user-1", Title: "画布", PayloadJSON: `{"nodes":[{"data":{"storageKey":"resource:resource-live"}}]}`}
	for _, item := range []any{&resource, &asset, &canvas} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.New(db)
	job := model.ResourceDeletionJob{
		ID: "should-not-commit", UserID: "user-1", ResourceID: resource.ID,
		Provider: "local", ObjectKey: objectKey, Status: model.ResourceDeletionStatusPending,
	}
	err := repo.DeleteAssetAndResources("user-1", asset.ID, []string{resource.ID}, []model.ResourceDeletionJob{job})
	if !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("DeleteAssetAndResources() error = %v", err)
	}
	var assetCount, resourceCount, jobCount int64
	if err := db.Model(&model.Asset{}).Where("id = ?", asset.ID).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Count(&resourceCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ResourceDeletionJob{}).Where("id = ?", job.ID).Count(&jobCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 1 || resourceCount != 1 || jobCount != 0 {
		t.Fatalf("tx leaked: asset=%d resource=%d job=%d", assetCount, resourceCount, jobCount)
	}
	if _, err := os.Stat(resourcePath); err != nil {
		t.Fatalf("bytes removed while delete aborted: %v", err)
	}
}

func TestDeleteAssetEnqueuesOutboxWithoutRemovingBytes(t *testing.T) {
	svc, db, dataDir := newDeletionDomain(t)
	objectKey := "users/user-1/image/queued-keep.png"
	resourcePath := filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "resource-keep", UserID: "user-1", Provider: "local", ObjectKey: objectKey, Status: model.ResourceStatusReady}
	asset := model.Asset{ID: "asset-keep", UserID: "user-1", Title: "可删素材", PayloadJSON: `{"data":{"storageKey":"resource:resource-keep"}}`}
	for _, item := range []any{&resource, &asset} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.DeleteUserAssetWithResources("user-1", asset.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(resourcePath); err != nil {
		t.Fatalf("metadata commit removed bytes: %v", err)
	}
	var resourceCount, jobCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Count(&resourceCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ResourceDeletionJob{}).Count(&jobCount).Error; err != nil {
		t.Fatal(err)
	}
	if resourceCount != 0 || jobCount != 1 {
		t.Fatalf("outbox state: resource=%d job=%d", resourceCount, jobCount)
	}
}

func TestDeleteAssetAndResourcesAbortsWhenQueuedTaskAppearsAfterPreflight(t *testing.T) {
	_, db, dataDir := newDeletionDomain(t)
	objectKey := "users/user-1/image/task-race.png"
	resourcePath := filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "resource-task-race", UserID: "user-1", Provider: "local", ObjectKey: objectKey, Status: model.ResourceStatusReady}
	asset := model.Asset{ID: "asset-task-race", UserID: "user-1", Title: "素材", PayloadJSON: `{"data":{"storageKey":"resource:resource-task-race"}}`}
	for _, item := range []any{&resource, &asset} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.New(db)
	snapshot, err := repo.ResourceReferenceSnapshot("user-1", asset.ID, []string{resource.ID})
	if err != nil {
		t.Fatal(err)
	}
	for _, document := range snapshot.Documents {
		if document.Kind == "任务" || document.Kind == "任务日志" || document.Kind == "任务结果" {
			t.Fatalf("preflight already saw %s %s", document.Kind, document.ID)
		}
	}
	task := model.Task{
		ID: "task-queued-after-preflight", UserID: "user-1", Prompt: "排队中的生成",
		Status: model.TaskStatusQueued, InputJSON: `{"storageKey":"resource:resource-task-race"}`,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	job := model.ResourceDeletionJob{
		ID: "should-not-commit-task", UserID: "user-1", ResourceID: resource.ID,
		Provider: "local", ObjectKey: objectKey, Status: model.ResourceDeletionStatusPending,
	}
	err = repo.DeleteAssetAndResources("user-1", asset.ID, []string{resource.ID}, []model.ResourceDeletionJob{job})
	if !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("DeleteAssetAndResources() error = %v", err)
	}
	var assetCount, resourceCount, jobCount, taskCount int64
	if err := db.Model(&model.Asset{}).Where("id = ?", asset.ID).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Count(&resourceCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ResourceDeletionJob{}).Where("id = ?", job.ID).Count(&jobCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Count(&taskCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 1 || resourceCount != 1 || jobCount != 0 || taskCount != 1 {
		t.Fatalf("tx leaked: asset=%d resource=%d job=%d task=%d", assetCount, resourceCount, jobCount, taskCount)
	}
	if _, err := os.Stat(resourcePath); err != nil {
		t.Fatalf("bytes removed while delete aborted: %v", err)
	}
}

func TestDeleteAssetAndResourcesAllowsCompletedTaskOutput(t *testing.T) {
	_, db, dataDir := newDeletionDomain(t)
	objectKey := "users/user-1/image/completed.png"
	resourcePath := filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	payload := `{"url":"/api/resources/resource-completed/file"}`
	resource := model.Resource{ID: "resource-completed", UserID: "user-1", Provider: "local", ObjectKey: objectKey, Status: model.ResourceStatusReady}
	asset := model.Asset{ID: "asset-completed", UserID: "user-1", Title: "生成图片", PayloadJSON: payload}
	task := model.Task{ID: "task-completed", UserID: "user-1", Prompt: "已完成", Status: model.TaskStatusSucceeded, InputJSON: `{}`, ResultJSON: payload}
	log := model.TaskLog{ID: "log-completed", UserID: "user-1", TaskID: task.ID, Payload: payload}
	result := model.Result{ID: "result-completed", UserID: "user-1", TaskID: task.ID, URL: "/api/resources/resource-completed/file", Payload: payload}
	for _, item := range []any{&resource, &asset, &task, &log, &result} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.New(db)
	job := model.ResourceDeletionJob{
		ID: "completed-output-job", UserID: "user-1", ResourceID: resource.ID,
		Provider: "local", ObjectKey: objectKey, Status: model.ResourceDeletionStatusPending,
	}
	if err := repo.DeleteAssetAndResources("user-1", asset.ID, []string{resource.ID}, []model.ResourceDeletionJob{job}); err != nil {
		t.Fatalf("completed output blocked delete: %v", err)
	}
	var resourceCount, jobCount, taskCount, logCount, resultCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Count(&resourceCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ResourceDeletionJob{}).Where("id = ?", job.ID).Count(&jobCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Count(&taskCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.TaskLog{}).Where("id = ?", log.ID).Count(&logCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Result{}).Where("id = ?", result.ID).Count(&resultCount).Error; err != nil {
		t.Fatal(err)
	}
	if resourceCount != 0 || jobCount != 1 || taskCount != 1 || logCount != 1 || resultCount != 1 {
		t.Fatalf("completed output delete: resource=%d job=%d task=%d log=%d result=%d", resourceCount, jobCount, taskCount, logCount, resultCount)
	}
	if _, err := os.Stat(resourcePath); err != nil {
		t.Fatalf("metadata commit removed bytes: %v", err)
	}
}

func TestDeleteAndAdmissionDoNotDropQueuedTaskMaterial(t *testing.T) {
	dataDir := t.TempDir()
	dsn := filepath.Join(dataDir, "race.db") + "?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	objectKey := "users/user-1/image/admit-race.png"
	resourcePath := filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("image"), 0o640); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "resource-admit-race", UserID: "user-1", Provider: "local", ObjectKey: objectKey, Status: model.ResourceStatusReady}
	asset := model.Asset{ID: "asset-admit-race", UserID: "user-1", Title: "素材", PayloadJSON: `{"data":{"storageKey":"resource:resource-admit-race"}}`}
	for _, item := range []any{&resource, &asset} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.New(db)
	job := model.ResourceDeletionJob{
		ID: "admit-race-job", UserID: "user-1", ResourceID: resource.ID,
		Provider: "local", ObjectKey: objectKey, Status: model.ResourceDeletionStatusPending,
	}
	task := model.Task{
		ID: "task-admit-race", UserID: "user-1", Prompt: "并发准入",
		Status: model.TaskStatusQueued, InputJSON: `{"storageKey":"resource:resource-admit-race"}`,
	}
	var deleteErr, admitErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		deleteErr = repo.DeleteAssetAndResources("user-1", asset.ID, []string{resource.ID}, []model.ResourceDeletionJob{job})
	}()
	go func() {
		defer wg.Done()
		admitErr = db.Transaction(func(tx *gorm.DB) error {
			if err := repository.RequireReadyOwnedResourcesTx(tx, "user-1", []string{resource.ID}); err != nil {
				return err
			}
			return tx.Create(&task).Error
		})
	}()
	wg.Wait()
	if deleteErr != nil && !errors.Is(deleteErr, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("delete: %v", deleteErr)
	}
	if admitErr != nil && !errors.Is(admitErr, repository.ErrResourceNotReadyForAdmission) {
		t.Fatalf("admit: %v", admitErr)
	}
	if deleteErr == nil && admitErr == nil {
		t.Fatal("delete and admission both committed")
	}
	var resourceCount, taskCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Count(&resourceCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Count(&taskCount).Error; err != nil {
		t.Fatal(err)
	}
	if taskCount == 1 && resourceCount == 0 {
		t.Fatal("queued task lost its material")
	}
	if admitErr == nil && resourceCount != 1 {
		t.Fatalf("admitted task but resource count=%d", resourceCount)
	}
	if errors.Is(deleteErr, repository.ErrResourceCleanupStillReferenced) && resourceCount != 1 {
		t.Fatalf("blocked delete dropped resource count=%d", resourceCount)
	}
}

func TestRequireReadyOwnedResourcesTxRejectsMissingAndNonReady(t *testing.T) {
	_, db, _ := newDeletionDomain(t)
	ready := model.Resource{ID: "resource-ready", UserID: "user-1", Provider: "local", ObjectKey: "users/user-1/image/ready.png", Status: model.ResourceStatusReady}
	pending := model.Resource{ID: "resource-pending", UserID: "user-1", Provider: "local", ObjectKey: "users/user-1/image/pending.png", Status: model.ResourceStatusPending}
	foreign := model.Resource{ID: "resource-foreign", UserID: "user-2", Provider: "local", ObjectKey: "users/user-2/image/foreign.png", Status: model.ResourceStatusReady}
	for _, item := range []any{&ready, &pending, &foreign} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := repository.RequireReadyOwnedResourcesTx(db, "user-1", []string{ready.ID, ready.ID}); err != nil {
		t.Fatalf("duplicate ready ids: %v", err)
	}
	if err := repository.RequireReadyOwnedResourcesTx(db, "user-1", []string{pending.ID}); !errors.Is(err, repository.ErrResourceNotReadyForAdmission) {
		t.Fatalf("pending: %v", err)
	}
	if err := repository.RequireReadyOwnedResourcesTx(db, "user-1", []string{"missing"}); !errors.Is(err, repository.ErrResourceNotReadyForAdmission) {
		t.Fatalf("missing: %v", err)
	}
	if err := repository.RequireReadyOwnedResourcesTx(db, "user-1", []string{foreign.ID}); !errors.Is(err, repository.ErrResourceNotReadyForAdmission) {
		t.Fatalf("foreign: %v", err)
	}
}

func TestDeletionWorkerRetriesFailedPhysicalDelete(t *testing.T) {
	svc, db, _ := newDeletionDomain(t)
	job := model.ResourceDeletionJob{
		ID: "deletion-retry", UserID: "user-1", ResourceID: "resource-missing",
		Provider: "local", ObjectKey: "../escape",
		Status: model.ResourceDeletionStatusPending, NextAttemptAt: time.Now().Add(-time.Second),
	}
	if err := db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	svc.DrainDeletionJobs(1)
	var remaining model.ResourceDeletionJob
	if err := db.First(&remaining, "id = ?", job.ID).Error; err != nil {
		t.Fatal(err)
	}
	if remaining.Status != model.ResourceDeletionStatusPending || remaining.Attempts == 0 || remaining.LastError == "" {
		t.Fatalf("retry job = %#v", remaining)
	}
}

func TestDeleteUserAssetWithResourcesHonorsArchivedExpectation(t *testing.T) {
	svc, db, _ := newDeletionDomain(t)
	archived := model.Asset{
		ID: "asset-archived", UserID: "user-1", Title: "回收站",
		Status: model.AssetVersionStatusArchived, PayloadJSON: `{"title":"回收站"}`,
	}
	restored := model.Asset{
		ID: "asset-restored", UserID: "user-1", Title: "已恢复",
		Status: model.AssetVersionStatusArchived, PayloadJSON: `{"title":"已恢复"}`,
	}
	for _, item := range []any{&archived, &restored} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.DeleteUserAssetWithResources("user-1", archived.ID, string(model.AssetVersionStatusArchived)); err != nil {
		t.Fatalf("archived delete: %v", err)
	}
	if err := db.Model(&model.Asset{}).Where("id = ?", restored.ID).Update("status", model.AssetVersionStatusConfirmed).Error; err != nil {
		t.Fatal(err)
	}
	err := svc.DeleteUserAssetWithResources("user-1", restored.ID, string(model.AssetVersionStatusArchived))
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Status != http.StatusConflict || !strings.Contains(err.Error(), "素材已不在回收站") {
		t.Fatalf("restored delete = %v", err)
	}
	var remaining model.Asset
	if err := db.First(&remaining, "id = ?", restored.ID).Error; err != nil {
		t.Fatalf("restored asset missing: %v", err)
	}
	if remaining.Status != model.AssetVersionStatusConfirmed {
		t.Fatalf("restored status = %s", remaining.Status)
	}
	if err := svc.DeleteUserAssetWithResources("user-1", restored.ID); err != nil {
		t.Fatalf("ordinary delete: %v", err)
	}
	if err := db.First(&model.Asset{}, "id = ?", restored.ID).Error; !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("ordinary delete left row: %v", err)
	}
	if err := db.First(&model.Asset{}, "id = ?", archived.ID).Error; !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("archived delete left row: %v", err)
	}
}

func TestDeleteAssetAndResourcesRejectsRestoredStatusInSameTransaction(t *testing.T) {
	_, db, _ := newDeletionDomain(t)
	asset := model.Asset{
		ID: "asset-tx-restored", UserID: "user-1", Title: "事务恢复",
		Status: model.AssetVersionStatusArchived, PayloadJSON: `{"title":"事务恢复"}`,
	}
	if err := db.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Asset{}).Where("id = ?", asset.ID).Update("status", model.AssetVersionStatusConfirmed).Error; err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	err := repo.DeleteAssetAndResources("user-1", asset.ID, nil, nil, string(model.AssetVersionStatusArchived))
	if !errors.Is(err, repository.ErrAssetExpectedStatusMismatch) {
		t.Fatalf("DeleteAssetAndResources() = %v", err)
	}
	var remaining model.Asset
	if err := db.First(&remaining, "id = ?", asset.ID).Error; err != nil {
		t.Fatalf("row missing: %v", err)
	}
	if remaining.Status != model.AssetVersionStatusConfirmed {
		t.Fatalf("status = %s", remaining.Status)
	}
}

func TestDeleteAssetAndResourcesConcurrentRestoreKeepsActiveAsset(t *testing.T) {
	dataDir := t.TempDir()
	dsn := filepath.Join(dataDir, "restore-race.db") + "?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	asset := model.Asset{
		ID: "asset-restore-race", UserID: "user-1", Title: "并发恢复",
		Status: model.AssetVersionStatusArchived, PayloadJSON: `{"title":"并发恢复"}`,
	}
	if err := db.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	var deleteErr, restoreErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		deleteErr = repo.DeleteAssetAndResources("user-1", asset.ID, nil, nil, string(model.AssetVersionStatusArchived))
	}()
	go func() {
		defer wg.Done()
		restoreErr = db.Model(&model.Asset{}).Where("id = ? AND user_id = ?", asset.ID, "user-1").Update("status", model.AssetVersionStatusConfirmed).Error
	}()
	wg.Wait()
	if restoreErr != nil {
		t.Fatalf("restore: %v", restoreErr)
	}
	var remaining model.Asset
	findErr := db.First(&remaining, "id = ?", asset.ID).Error
	if findErr == nil {
		if remaining.Status != model.AssetVersionStatusConfirmed {
			t.Fatalf("remaining status = %s", remaining.Status)
		}
		if !errors.Is(deleteErr, repository.ErrAssetExpectedStatusMismatch) {
			t.Fatalf("active row kept but delete err = %v", deleteErr)
		}
		return
	}
	if !errors.Is(findErr, gorm.ErrRecordNotFound) {
		t.Fatalf("lookup: %v", findErr)
	}
	if deleteErr != nil {
		t.Fatalf("row gone but delete err = %v", deleteErr)
	}
}
