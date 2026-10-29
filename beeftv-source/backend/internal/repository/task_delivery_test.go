package repository

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestUpsertGenerationDeliverySurvivesSQLiteReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "delivery.db")
	open := func() (*gorm.DB, *Repository) {
		t.Helper()
		db, err := gorm.Open(sqlite.Open(path+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{})
		if err != nil {
			t.Fatal(err)
		}
		if err := db.AutoMigrate(&model.Task{}, &model.Result{}, &model.Asset{}, &model.AssetVersion{}, &model.AssetRepresentation{}, &model.Resource{}); err != nil {
			t.Fatal(err)
		}
		return db, New(db)
	}

	db, repo := open()
	now := time.Now()
	if err := db.Create(&model.Task{ID: "task-1", UserID: "user-1", Status: model.TaskStatusSucceeded, ResultJSON: `{"images":[{"resourceId":"res-1"}]}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	item := sampleDeliveryItem(now)
	if err := repo.UpsertGenerationDelivery([]GenerationDeliveryItem{item}); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertGenerationDelivery([]GenerationDeliveryItem{item}); err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, repo := open()
	defer func() {
		sqlDB, _ := reopened.DB()
		if sqlDB != nil {
			_ = sqlDB.Close()
		}
	}()
	results, err := repo.GenerationOutputResults("task-1")
	if err != nil || len(results) != 1 || results[0].Payload != item.Result.Payload {
		t.Fatalf("reopened results = %#v err=%v", results, err)
	}
	var assets, versions, representations int64
	if err := reopened.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 1 {
		t.Fatalf("assets = %d err=%v", assets, err)
	}
	if err := reopened.Model(&model.AssetVersion{}).Count(&versions).Error; err != nil || versions != 1 {
		t.Fatalf("versions = %d err=%v", versions, err)
	}
	if err := reopened.Model(&model.AssetRepresentation{}).Count(&representations).Error; err != nil || representations != 1 {
		t.Fatalf("representations = %d err=%v", representations, err)
	}
}

func TestCommitOwnedGenerationDeliveryPreservesEditedMetadata(t *testing.T) {
	path := filepath.Join(t.TempDir(), "delivery-preserve.db")
	db, err := gorm.Open(sqlite.Open(path+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.Result{}, &model.Asset{}, &model.AssetVersion{}, &model.AssetRepresentation{}, &model.Resource{}); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	now := time.Now()
	item := sampleDeliveryItem(now)
	if err := repo.CommitOwnedGenerationDelivery(item); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Asset{}).Where("id = ?", item.Asset.ID).Updates(map[string]any{
		"title":        "用户改过的标题",
		"folder_id":    "folder-user",
		"payload_json": `{"id":"generation_asset_1","title":"用户改过的标题"}`,
	}).Error; err != nil {
		t.Fatal(err)
	}
	item.Asset.Title = "生成图片"
	item.Asset.FolderID = ""
	item.Asset.PayloadJSON = `{"id":"generation_asset_1"}`
	if err := repo.CommitOwnedGenerationDelivery(item); err != nil {
		t.Fatal(err)
	}
	var stored model.Asset
	if err := db.First(&stored, "id = ?", item.Asset.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Title != "用户改过的标题" || stored.FolderID != "folder-user" || stored.PayloadJSON != `{"id":"generation_asset_1","title":"用户改过的标题"}` {
		t.Fatalf("user metadata overwritten: %#v", stored)
	}
}

func TestCommitOwnedGenerationDeliveryRejectsForeignAsset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "delivery-foreign.db")
	db, err := gorm.Open(sqlite.Open(path+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.Result{}, &model.Asset{}, &model.AssetVersion{}, &model.AssetRepresentation{}, &model.Resource{}); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	now := time.Now()
	item := sampleDeliveryItem(now)
	item.Asset.UserID = "other-user"
	item.Asset.Title = "别人的素材"
	if err := db.Create(item.Asset).Error; err != nil {
		t.Fatal(err)
	}
	item.Asset.UserID = "user-1"
	item.Asset.Title = "生成图片"
	if err := repo.CommitOwnedGenerationDelivery(item); !errors.Is(err, ErrAssetOwnedByAnotherUser) {
		t.Fatalf("foreign collision = %v", err)
	}
	var stored model.Asset
	if err := db.First(&stored, "id = ?", item.Asset.ID).Error; err != nil || stored.UserID != "other-user" || stored.Title != "别人的素材" {
		t.Fatalf("foreign asset mutated: %#v err=%v", stored, err)
	}
}

func sampleDeliveryItem(now time.Time) GenerationDeliveryItem {
	assetID := "generation_asset_1"
	versionID := "version000000000000000000000001"
	return GenerationDeliveryItem{
		Result:         model.Result{ID: "result00000000000000000000000001", UserID: "user-1", TaskID: "task-1", Kind: generationOutputResultKind, URL: "/api/resources/res-1/file", Payload: `{"outputIndex":0,"resourceId":"res-1","materializedAssetId":"generation_asset_1"}`, CreatedAt: now},
		Asset:          &model.Asset{ID: assetID, UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, PrimaryVersionID: versionID, Title: "生成图片", PayloadJSON: `{"id":"generation_asset_1"}`, CreatedAt: now, UpdatedAt: now},
		Version:        &model.AssetVersion{ID: versionID, AssetID: assetID, Version: 1, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: "{}", CreatedAt: now, UpdatedAt: now},
		Representation: &model.AssetRepresentation{ID: "repr0000000000000000000000000001", TaskID: "task-1", AssetVersionID: versionID, ResourceID: "res-1", MediaType: "image", Role: "output", CreatedAt: now},
	}
}
