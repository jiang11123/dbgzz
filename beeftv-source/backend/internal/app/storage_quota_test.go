package app

import (
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestSaveTaskCompletionDiskFullPreservesOriginalTask(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.Asset{}, &model.CanvasProject{}, &model.Task{}, &model.TaskLog{}, &model.Result{}, &model.ApiCallLog{}, &model.TaskTextDelta{}); err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "task-full", UserID: "user-1", Status: model.TaskStatusFailed, InputJSON: `{"mode":"video"}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	cause := errors.New("database or disk is full")
	if err := db.Callback().Update().Before("gorm:update").Register("test:task-disk-full", func(tx *gorm.DB) {
		if tx.Statement.Table == "tasks" {
			tx.AddError(cause)
		}
	}); err != nil {
		t.Fatal(err)
	}
	svc := &Service{repo: repository.New(db)}
	err = svc.saveTaskCompletionWithinStorageQuota(&task, []byte(`{"ok":true}`), nil, false)
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Reason != "local_disk_full" || !errors.Is(err, cause) || strings.Contains(appErr.Message, "尚未提交") {
		t.Fatalf("completion failure = %v", err)
	}
	var saved model.Task
	if err := db.First(&saved, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusFailed || saved.Status != model.TaskStatusFailed || saved.ResultJSON != "" {
		t.Fatalf("failed recovery changed task: memory=%s saved=%#v", task.Status, saved)
	}
}

func TestValidateStructuredStorageQuotaRejectsBytesAndCounts(t *testing.T) {
	policy := defaultRuntimePolicy().Resource
	usage := repository.UserStorageUsage{AssetBytes: megabytes(policy.StructuredDataMB) - 8, AssetCount: policy.AssetCount}
	if err := validateStructuredStorageQuotaWithPolicy(usage, "asset", false, 9, policy); err == nil {
		t.Fatal("validateStructuredStorageQuota() byte error = nil")
	}
	err := validateStructuredStorageQuotaWithPolicy(usage, "asset", true, 0, policy)
	var quota *AppError
	if err == nil || !errors.As(err, &quota) || quota.Code != CodeQuotaExceeded || quota.Status != CodeForbidden {
		t.Fatalf("validateStructuredStorageQuota() count error = %v", err)
	}
}

func TestValidateStructuredCountQuotaRejectsBatchOverAssetLimit(t *testing.T) {
	policy := defaultRuntimePolicy().Resource
	policy.AssetCount = 2
	usage := repository.UserStorageUsage{AssetCount: 1}
	if err := validateStructuredCountQuotaWithPolicy(usage, "asset", 1, 0, policy); err != nil {
		t.Fatalf("single create within limit = %v", err)
	}
	err := validateStructuredCountQuotaWithPolicy(usage, "asset", 2, 0, policy)
	var quota *AppError
	if err == nil || !errors.As(err, &quota) || quota.Code != CodeQuotaExceeded {
		t.Fatalf("batch create error = %v", err)
	}
}

func TestValidateStructuredStorageQuotaAllowsReplacementThatShrinksData(t *testing.T) {
	policy := defaultRuntimePolicy().Resource
	usage := repository.UserStorageUsage{AssetBytes: megabytes(policy.StructuredDataMB), AssetCount: policy.AssetCount}
	if err := validateStructuredStorageQuotaWithPolicy(usage, "asset", false, -1, policy); err != nil {
		t.Fatalf("validateStructuredStorageQuota() error = %v", err)
	}
}

func TestValidateTaskStorageQuotaRejectsHistoryGrowth(t *testing.T) {
	policy := defaultRuntimePolicy().Resource
	if err := validateTaskStorageQuotaWithPolicy(repository.UserStorageUsage{TaskCount: policy.TaskCount}, 0, policy); err == nil {
		t.Fatal("validateTaskStorageQuota() count error = nil")
	}
	if err := validateTaskStorageQuotaWithPolicy(repository.UserStorageUsage{TaskBytes: gigabytes(policy.TaskDataGB)}, 1, policy); err == nil {
		t.Fatal("validateTaskStorageQuota() byte error = nil")
	}
	if err := validateAPICallLogQuotaWithPolicy(repository.UserStorageUsage{APICallCount: policy.APICallLogCount}, 0, policy); err == nil {
		t.Fatal("validateAPICallLogQuota() count error = nil")
	}
}

func TestUserStorageUsageCountsPersistedPayloads(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.Asset{}, &model.CanvasProject{}, &model.Task{}, &model.TaskLog{}, &model.Result{}, &model.ApiCallLog{}, &model.TaskTextDelta{}); err != nil {
		t.Fatal(err)
	}
	items := []any{
		&model.Asset{ID: "asset-1", UserID: "user-1", PayloadJSON: "abcd"},
		&model.CanvasProject{ID: "canvas-1", UserID: "user-1", PayloadJSON: "xy"},
		&model.Task{ID: "task-1", UserID: "user-1", Prompt: "p", InputJSON: "{}", ResultJSON: "{}"},
		&model.TaskLog{ID: "log-1", UserID: "user-1", TaskID: "task-1", Message: "m", Payload: "p"},
		&model.Result{ID: "result-1", UserID: "user-1", TaskID: "task-1", URL: "u", Payload: "r"},
		&model.ApiCallLog{ID: "api-log-1", UserID: "user-1", Path: "p", Model: "m", ProviderRequestID: "i", Error: "e", UpstreamURL: "u"},
	}
	for _, item := range items {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	usage, err := repository.New(db).UserStorageUsage("user-1")
	if err != nil {
		t.Fatal(err)
	}
	if usage.AssetCount != 1 || usage.AssetBytes != 4 || usage.CanvasCount != 1 || usage.CanvasBytes != 2 || usage.TaskCount != 1 || usage.TaskBytes != 14 || usage.APICallCount != 1 {
		t.Fatalf("UserStorageUsage() = %#v", usage)
	}
}

func TestSaveTaskCompletionPersistsRelatedRowsTogether(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.Asset{}, &model.CanvasProject{}, &model.Task{}, &model.TaskLog{}, &model.Result{}, &model.ApiCallLog{}, &model.TaskTextDelta{}); err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "task-1", UserID: "user-1", Status: model.TaskStatusRunning, InputJSON: `{"mode":"text"}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	svc := &Service{repo: repository.New(db)}
	if err := svc.saveTaskCompletionWithinStorageQuota(&task, []byte(`{"ok":true}`), []byte(`[{"op":"add"}]`), true); err != nil {
		t.Fatal(err)
	}
	var resultCount int64
	if err := db.Model(&model.Result{}).Count(&resultCount).Error; err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusSucceeded || resultCount != 1 {
		t.Fatalf("completion = status:%s results:%d", task.Status, resultCount)
	}
}
