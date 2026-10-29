package asset

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func TestCreateAssetFolderRejectsConcurrentDuplicateName(t *testing.T) {
	lib, _ := newLibraryFixture(t)
	start := make(chan struct{})
	errorsCh := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, createErr := lib.CreateAssetFolder("owner", CreateAssetFolderRequest{Name: "灵感"})
			errorsCh <- createErr
		}()
	}
	close(start)
	wg.Wait()
	close(errorsCh)
	success, conflict := 0, 0
	for err := range errorsCh {
		if err == nil {
			success++
			continue
		}
		if strings.Contains(err.Error(), "已存在同名素材分类") {
			conflict++
			continue
		}
		t.Fatalf("unexpected error: %v", err)
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflict)
	}
	folders, err := lib.AssetFolders("owner")
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 1 || folders[0].Name != "灵感" {
		t.Fatalf("folders = %#v", folders)
	}
}

func TestCreateAssetFolderMapsUniqueConstraint(t *testing.T) {
	lib, db := newLibraryFixture(t)
	now := time.Now().UTC()
	if err := db.Create(&model.AssetFolder{ID: "folder-existing", UserID: "owner", Name: "灵感", NameKey: "灵感", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	_, err := lib.CreateAssetFolder("owner", CreateAssetFolderRequest{Name: "灵感"})
	if err == nil || !strings.Contains(err.Error(), "已存在同名素材分类") {
		t.Fatalf("error = %v", err)
	}
}

func TestMoveUserAssetsRejectsDeletedFolderInSameTransaction(t *testing.T) {
	lib, db := newLibraryFixture(t)
	now := time.Now().UTC()
	folder := model.AssetFolder{ID: "folder-1", UserID: "owner", Name: "灵感", NameKey: "灵感", Position: 0, CreatedAt: now, UpdatedAt: now}
	item := model.Asset{ID: "asset-1", UserID: "owner", FolderID: "", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "海边", PayloadJSON: `{"id":"asset-1","kind":"image","title":"海边","coverUrl":"","tags":[],"data":{"dataUrl":"https://example.com/a.png","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&folder).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	if err := lib.DeleteAssetFolder("owner", folder.ID); err != nil {
		t.Fatal(err)
	}
	err := lib.MoveUserAssetsToFolder("owner", MoveUserAssetsRequest{AssetIDs: []string{"asset-1"}, FolderID: folder.ID})
	if err == nil || !strings.Contains(err.Error(), "目标素材分类不存在") {
		t.Fatalf("move error = %v", err)
	}
	stored, err := lib.repo.AssetForUser("owner", "asset-1")
	if err != nil {
		t.Fatal(err)
	}
	if stored.FolderID != "" {
		t.Fatalf("asset assigned to deleted folder: %#v", stored)
	}
}

func TestMoveUserAssetsConcurrentWithFolderDeleteStaysConsistent(t *testing.T) {
	lib, db := newLibraryFixture(t)
	now := time.Now().UTC()
	folder := model.AssetFolder{ID: "folder-race", UserID: "owner", Name: "灵感", NameKey: "灵感", Position: 0, CreatedAt: now, UpdatedAt: now}
	item := model.Asset{ID: "asset-race", UserID: "owner", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "海边", PayloadJSON: `{"id":"asset-race","kind":"image","title":"海边","coverUrl":"","tags":[],"source":"生成任务","data":{"dataUrl":"https://example.com/a.png","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&folder).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_ = lib.DeleteAssetFolder("owner", folder.ID)
	}()
	go func() {
		defer wg.Done()
		<-start
		_ = lib.MoveUserAssetsToFolder("owner", MoveUserAssetsRequest{AssetIDs: []string{"asset-race"}, FolderID: folder.ID})
	}()
	close(start)
	wg.Wait()
	stored, err := lib.repo.AssetForUser("owner", "asset-race")
	if err != nil {
		t.Fatal(err)
	}
	if stored.FolderID != "" {
		if _, folderErr := lib.repo.AssetFolderForUser("owner", stored.FolderID); folderErr != nil {
			t.Fatalf("asset points at missing folder %q: %v", stored.FolderID, folderErr)
		}
	}
	if !strings.Contains(stored.PayloadJSON, `"source":"生成任务"`) {
		t.Fatalf("generation source overwritten: %s", stored.PayloadJSON)
	}
}

func TestUpdateAssetFolderMapsMissingRecord(t *testing.T) {
	lib, _ := newLibraryFixture(t)
	_, err := lib.UpdateAssetFolder("owner", "missing", UpdateAssetFolderRequest{Name: "新名称"})
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || !strings.Contains(err.Error(), "素材分类不存在") {
		t.Fatalf("error = %v", err)
	}
}

func TestMoveUserAssetsRejectsForeignAsset(t *testing.T) {
	lib, db := newLibraryFixture(t)
	now := time.Now().UTC()
	folder := model.AssetFolder{ID: "folder-1", UserID: "owner", Name: "灵感", NameKey: "灵感", CreatedAt: now, UpdatedAt: now}
	assets := []model.Asset{
		{ID: "asset-1", UserID: "owner", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "海边", PayloadJSON: `{"id":"asset-1"}`, CreatedAt: now, UpdatedAt: now},
		{ID: "asset-2", UserID: "other", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "他人", PayloadJSON: `{"id":"asset-2"}`, CreatedAt: now, UpdatedAt: now},
	}
	if err := db.Create(&folder).Error; err != nil {
		t.Fatal(err)
	}
	for index := range assets {
		if err := db.Create(&assets[index]).Error; err != nil {
			t.Fatal(err)
		}
	}
	err := lib.MoveUserAssetsToFolder("owner", MoveUserAssetsRequest{AssetIDs: []string{"asset-1", "asset-2"}, FolderID: folder.ID})
	if err == nil || !strings.Contains(err.Error(), "部分素材不存在或不属于当前用户") {
		t.Fatalf("error = %v", err)
	}
	stored, err := lib.repo.AssetForUser("owner", "asset-1")
	if err != nil {
		t.Fatal(err)
	}
	if stored.FolderID != "" {
		t.Fatalf("partial move: %#v", stored)
	}
}

func TestDeleteMissingFolder(t *testing.T) {
	lib, _ := newLibraryFixture(t)
	err := lib.DeleteAssetFolder("owner", "missing")
	if err == nil || !strings.Contains(err.Error(), "素材分类不存在") {
		t.Fatalf("error = %v", err)
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatal("raw record-not-found leaked")
	}
}
