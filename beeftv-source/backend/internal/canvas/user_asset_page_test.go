package canvas

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestUserAssetsPageBelongsToCanvasContract(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:canvas-asset-page?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Asset{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for _, asset := range []model.Asset{
		{ID: "asset-1", UserID: "owner", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "海边", PayloadJSON: `{"id":"asset-1","kind":"image","title":"海边"}`, CreatedAt: now, UpdatedAt: now},
		{ID: "asset-2", UserID: "owner", Kind: "text", Category: model.AssetCategoryOther, Status: model.AssetVersionStatusConfirmed, Title: "提示词", PayloadJSON: `{"id":"asset-2","kind":"text","title":"提示词"}`, CreatedAt: now, UpdatedAt: now.Add(time.Second)},
		{ID: "asset-3", UserID: "other", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "他人", PayloadJSON: `{"id":"asset-3","kind":"image","title":"他人"}`, CreatedAt: now, UpdatedAt: now},
	} {
		if err := db.Create(&asset).Error; err != nil {
			t.Fatal(err)
		}
	}
	page, err := New(repository.New(db), nil).UserAssetsPage("owner", 1, 10, UserAssetPageFilter{Kind: "image", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Assets) != 1 || page.KindCounts["image"] != 1 {
		t.Fatalf("page = %#v", page)
	}
}
