package repository

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newAssetLibraryTestRepository(t *testing.T) (*Repository, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:asset-library-test-%d?mode=memory&cache=shared", time.Now().UnixNano())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Asset{}, &model.AssetFolder{}); err != nil {
		t.Fatal(err)
	}
	return New(db), db
}

func TestUserAssetsPagePaginatesAndIsolatesUsers(t *testing.T) {
	repo, db := newAssetLibraryTestRepository(t)
	now := time.Now().UTC()
	for _, asset := range []model.Asset{
		{ID: "asset-1", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "海边", PayloadJSON: `{"id":"asset-1","title":"海边"}`, CreatedAt: now, UpdatedAt: now},
		{ID: "asset-2", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "室内", PayloadJSON: `{"id":"asset-2","title":"室内"}`, CreatedAt: now, UpdatedAt: now.Add(time.Second)},
		{ID: "asset-3", UserID: "user-1", Kind: "text", Category: model.AssetCategoryOther, Status: model.AssetVersionStatusConfirmed, Title: "提示词", PayloadJSON: `{"id":"asset-3","title":"提示词"}`, CreatedAt: now, UpdatedAt: now.Add(2 * time.Second)},
		{ID: "asset-4", UserID: "user-2", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "他人素材", PayloadJSON: `{"id":"asset-4","title":"他人素材"}`, CreatedAt: now, UpdatedAt: now},
	} {
		if err := db.Create(&asset).Error; err != nil {
			t.Fatal(err)
		}
	}

	assets, total, err := repo.UserAssetsPage("user-1", 2, 1, UserAssetPageFilter{Kind: "image", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	if total != 2 || len(assets) != 1 || assets[0].ID != "asset-1" {
		t.Fatalf("page result = total %d, assets %#v; want total 2 and asset-1", total, assets)
	}
}

func TestDeleteAssetFolderMovesAssetsToUncategorized(t *testing.T) {
	repo, db := newAssetLibraryTestRepository(t)
	now := time.Now().UTC()
	folder := model.AssetFolder{ID: "folder-1", UserID: "user-1", Name: "灵感", NameKey: "灵感", Position: 0, CreatedAt: now, UpdatedAt: now}
	asset := model.Asset{ID: "asset-1", UserID: "user-1", FolderID: folder.ID, Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "海边", PayloadJSON: `{"id":"asset-1","folderId":"folder-1"}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&folder).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}

	if err := repo.DeleteAssetFolder("user-1", folder.ID); err != nil {
		t.Fatal(err)
	}
	var moved model.Asset
	if err := db.First(&moved, "id = ?", asset.ID).Error; err != nil {
		t.Fatal(err)
	}
	if moved.FolderID != "" || strings.Contains(moved.PayloadJSON, "folderId") {
		t.Fatalf("asset after folder deletion = %#v", moved)
	}
}

func TestMoveUserAssetsToFolderRejectsMissingFolder(t *testing.T) {
	repo, db := newAssetLibraryTestRepository(t)
	now := time.Now().UTC()
	asset := model.Asset{ID: "asset-1", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "海边", PayloadJSON: `{"id":"asset-1"}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.MoveUserAssetsToFolder("user-1", []string{"asset-1"}, "missing-folder"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("move error = %v, want record-not-found", err)
	}
	var unchanged model.Asset
	if err := db.First(&unchanged, "id = ?", "asset-1").Error; err != nil {
		t.Fatal(err)
	}
	if unchanged.FolderID != "" {
		t.Fatalf("missing folder caused assignment: %#v", unchanged)
	}
}

func TestAssignUserAssetFolderDoesNotOverwriteConcurrentPayload(t *testing.T) {
	repo, db := newAssetLibraryTestRepository(t)
	now := time.Now().UTC()
	original := `{"id":"asset-1","source":"生成任务","folderId":""}`
	updated := `{"id":"asset-1","source":"生成任务","title":"已物化","folderId":""}`
	asset := model.Asset{ID: "asset-1", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "海边", PayloadJSON: original, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Asset{}).Where("id = ?", asset.ID).Update("payload_json", updated).Error; err != nil {
		t.Fatal(err)
	}
	patched, err := assetPayloadWithFolder(original, "folder-1", now)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := repo.AssignUserAssetFolder("user-1", "asset-1", "folder-1", patched, original, now)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("stale folder assignment succeeded")
	}
	var stored model.Asset
	if err := db.First(&stored, "id = ?", "asset-1").Error; err != nil {
		t.Fatal(err)
	}
	if stored.FolderID != "" || stored.PayloadJSON != updated {
		t.Fatalf("generation payload overwritten: %#v", stored)
	}
}

func TestMoveUserAssetsToFolderRollsBackWhenAnyAssetIsForeign(t *testing.T) {
	repo, db := newAssetLibraryTestRepository(t)
	now := time.Now().UTC()
	folder := model.AssetFolder{ID: "folder-1", UserID: "user-1", Name: "灵感", NameKey: "灵感", Position: 0, CreatedAt: now, UpdatedAt: now}
	assets := []model.Asset{
		{ID: "asset-1", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "海边", PayloadJSON: `{"id":"asset-1"}`, CreatedAt: now, UpdatedAt: now},
		{ID: "asset-2", UserID: "user-2", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "他人素材", PayloadJSON: `{"id":"asset-2"}`, CreatedAt: now, UpdatedAt: now},
	}
	if err := db.Create(&folder).Error; err != nil {
		t.Fatal(err)
	}
	for index := range assets {
		if err := db.Create(&assets[index]).Error; err != nil {
			t.Fatal(err)
		}
	}

	if err := repo.MoveUserAssetsToFolder("user-1", []string{"asset-1", "asset-2"}, folder.ID); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("move error = %v, want record-not-found", err)
	}
	var unchanged model.Asset
	if err := db.First(&unchanged, "id = ?", "asset-1").Error; err != nil {
		t.Fatal(err)
	}
	if unchanged.FolderID != "" {
		t.Fatalf("foreign asset caused partial move: %#v", unchanged)
	}
}

func TestUserAssetsPageFiltersFavoriteRecentProjectBeforePagination(t *testing.T) {
	repo, db := newAssetLibraryTestRepository(t)
	now := time.Now().UTC()
	create := func(asset model.Asset) {
		t.Helper()
		if err := db.Create(&asset).Error; err != nil {
			t.Fatal(err)
		}
	}
	for index := 1; index <= 125; index++ {
		id := fmt.Sprintf("fav-%03d", index)
		create(model.Asset{
			ID: id, UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
			Title: id, PayloadJSON: fmt.Sprintf(`{"id":%q,"title":%q,"metadata":{"favorite":true}}`, id, id),
			CreatedAt: now, UpdatedAt: now.Add(time.Duration(index) * time.Second),
		})
	}
	create(model.Asset{
		ID: "plain-old", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
		Title: "普通旧素材", PayloadJSON: `{"id":"plain-old","title":"普通旧素材","metadata":{"favorite":false}}`,
		CreatedAt: now.Add(-40 * 24 * time.Hour), UpdatedAt: now.Add(-40 * 24 * time.Hour),
	})
	create(model.Asset{
		ID: "recent-plain", UserID: "user-1", Kind: "text", Category: model.AssetCategoryOther, Status: model.AssetVersionStatusConfirmed,
		Title: "最近文本", PayloadJSON: `{"id":"recent-plain","title":"最近文本","metadata":{"projectName":"海边剧"}}`,
		CreatedAt: now, UpdatedAt: now.Add(200 * time.Second),
	})
	create(model.Asset{
		ID: "named-project", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
		Title: "具名项目", PayloadJSON: `{"id":"named-project","title":"具名项目","metadata":{"projectName":" 海边剧 "}}`,
		CreatedAt: now, UpdatedAt: now.Add(201 * time.Second),
	})
	create(model.Asset{
		ID: "linked-project", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
		Title: "已关联", PayloadJSON: `{"id":"linked-project","title":"已关联","metadata":{"projectIds":["p-1"]}}`,
		CreatedAt: now, UpdatedAt: now.Add(202 * time.Second),
	})
	create(model.Asset{
		ID: "unlinked-project", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
		Title: "未关联", PayloadJSON: `{"id":"unlinked-project","title":"未关联","metadata":{}}`,
		CreatedAt: now, UpdatedAt: now.Add(203 * time.Second),
	})
	create(model.Asset{
		ID: "other-user", UserID: "user-2", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
		Title: "他人收藏", PayloadJSON: `{"id":"other-user","metadata":{"favorite":true}}`,
		CreatedAt: now, UpdatedAt: now,
	})

	page1, total, err := repo.UserAssetsPage("user-1", 1, 40, UserAssetPageFilter{Status: "active", Favorite: true})
	if err != nil {
		t.Fatal(err)
	}
	if total != 125 || len(page1) != 40 || page1[0].ID != "fav-125" || page1[39].ID != "fav-086" {
		t.Fatalf("favorite page1 = total %d ids %s", total, assetIDs(page1))
	}
	page2, total, err := repo.UserAssetsPage("user-1", 2, 40, UserAssetPageFilter{Status: "active", Favorite: true})
	if err != nil {
		t.Fatal(err)
	}
	if total != 125 || len(page2) != 40 || page2[0].ID != "fav-085" || page2[39].ID != "fav-046" {
		t.Fatalf("favorite page2 = total %d ids %s", total, assetIDs(page2))
	}
	page4, total, err := repo.UserAssetsPage("user-1", 4, 40, UserAssetPageFilter{Status: "active", Favorite: true})
	if err != nil {
		t.Fatal(err)
	}
	if total != 125 || len(page4) != 5 || page4[0].ID != "fav-005" || page4[4].ID != "fav-001" {
		t.Fatalf("favorite page4 = total %d ids %s", total, assetIDs(page4))
	}
	for _, item := range page1 {
		for _, other := range page2 {
			if item.ID == other.ID {
				t.Fatalf("favorite pages overlap on %s", item.ID)
			}
		}
	}

	recent, recentTotal, err := repo.UserAssetsPage("user-1", 1, 40, UserAssetPageFilter{Status: "active", Recent: true})
	if err != nil {
		t.Fatal(err)
	}
	if recentTotal != 129 || len(recent) != 40 {
		t.Fatalf("recent = total %d count %d ids %s", recentTotal, len(recent), assetIDs(recent))
	}
	for _, item := range recent {
		if item.ID == "plain-old" {
			t.Fatal("recent page included a 40-day-old asset")
		}
	}

	named, namedTotal, err := repo.UserAssetsPage("user-1", 1, 40, UserAssetPageFilter{Status: "active", Project: "海边剧"})
	if err != nil {
		t.Fatal(err)
	}
	if namedTotal != 2 || !assetIDSet(named).Equal("recent-plain", "named-project") {
		t.Fatalf("named project = total %d ids %s", namedTotal, assetIDs(named))
	}
	linked, linkedTotal, err := repo.UserAssetsPage("user-1", 1, 40, UserAssetPageFilter{Status: "active", Project: "已关联项目"})
	if err != nil {
		t.Fatal(err)
	}
	if linkedTotal != 1 || len(linked) != 1 || linked[0].ID != "linked-project" {
		t.Fatalf("linked project = total %d ids %s", linkedTotal, assetIDs(linked))
	}
	unlinked, unlinkedTotal, err := repo.UserAssetsPage("user-1", 1, 40, UserAssetPageFilter{Status: "active", Project: "未关联项目"})
	if err != nil {
		t.Fatal(err)
	}
	if unlinkedTotal != 127 || len(unlinked) != 40 {
		t.Fatalf("unlinked project total = %d count %d", unlinkedTotal, len(unlinked))
	}

	favoriteCount, recentCount, err := repo.UserAssetQuickFilterCounts("user-1")
	if err != nil {
		t.Fatal(err)
	}
	if favoriteCount != 125 || recentCount != 129 {
		t.Fatalf("quick counts favorite=%d recent=%d", favoriteCount, recentCount)
	}

	projectRows, err := repo.UserAssetProjectCounts("user-1")
	if err != nil {
		t.Fatal(err)
	}
	projectCounts := facetCountMap(projectRows)
	if projectCounts["海边剧"] != 2 || projectCounts["已关联项目"] != 1 || projectCounts["未关联项目"] != 127 || len(projectCounts) != 3 {
		t.Fatalf("project counts = %#v", projectCounts)
	}
}

func TestUserAssetsPageFiltersGeneratedBeforePagination(t *testing.T) {
	repo, db := newAssetLibraryTestRepository(t)
	now := time.Now().UTC()
	create := func(asset model.Asset) {
		t.Helper()
		if err := db.Create(&asset).Error; err != nil {
			t.Fatal(err)
		}
	}
	for index := 1; index <= 80; index++ {
		id := fmt.Sprintf("plain-%03d", index)
		create(model.Asset{
			ID: id, UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
			Title: id, PayloadJSON: fmt.Sprintf(`{"id":%q,"title":%q,"source":"Canvas"}`, id, id),
			CreatedAt: now, UpdatedAt: now.Add(time.Duration(200+index) * time.Second),
		})
	}
	for index := 1; index <= 110; index++ {
		id := fmt.Sprintf("gen-img-%03d", index)
		create(model.Asset{
			ID: id, UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
			Title: id, PayloadJSON: fmt.Sprintf(`{"id":%q,"title":%q,"source":"生成任务"}`, id, id),
			CreatedAt: now, UpdatedAt: now.Add(time.Duration(index) * time.Second),
		})
	}
	for index := 1; index <= 10; index++ {
		id := fmt.Sprintf("gen-key-%03d", index)
		create(model.Asset{
			ID: id, UserID: "user-1", Kind: "video", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
			Title: id, PayloadJSON: fmt.Sprintf(`{"id":%q,"title":%q,"metadata":{"generationEffectKey":"seedance"}}`, id, id),
			CreatedAt: now, UpdatedAt: now.Add(time.Duration(110+index) * time.Second),
		})
	}
	for index := 1; index <= 5; index++ {
		id := fmt.Sprintf("gen-audio-%03d", index)
		create(model.Asset{
			ID: id, UserID: "user-1", Kind: "audio", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
			Title: id, PayloadJSON: fmt.Sprintf(`{"id":%q,"title":%q,"source":"生成任务"}`, id, id),
			CreatedAt: now, UpdatedAt: now.Add(time.Duration(120+index) * time.Second),
		})
	}
	create(model.Asset{
		ID: "gen-text", UserID: "user-1", Kind: "text", Category: model.AssetCategoryOther, Status: model.AssetVersionStatusConfirmed,
		Title: "生成文本", PayloadJSON: `{"id":"gen-text","source":"生成任务"}`, CreatedAt: now, UpdatedAt: now.Add(400 * time.Second),
	})
	create(model.Asset{
		ID: "gen-archived", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusArchived,
		Title: "归档生成", PayloadJSON: `{"id":"gen-archived","source":"生成任务"}`, CreatedAt: now, UpdatedAt: now.Add(401 * time.Second),
	})
	create(model.Asset{
		ID: "gen-entity", UserID: "user-1", Kind: "entity", Category: model.AssetCategoryOther, Status: model.AssetVersionStatusConfirmed,
		Title: "角色", PayloadJSON: `{"id":"gen-entity","source":"生成任务"}`, CreatedAt: now, UpdatedAt: now.Add(402 * time.Second),
	})
	create(model.Asset{
		ID: "gen-other", UserID: "user-2", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
		Title: "他人生成", PayloadJSON: `{"id":"gen-other","source":"生成任务"}`, CreatedAt: now, UpdatedAt: now,
	})

	unfiltered, unfilteredTotal, err := repo.UserAssetsPage("user-1", 1, 120, UserAssetPageFilter{Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	if unfilteredTotal != 206 || len(unfiltered) != 120 {
		t.Fatalf("unfiltered page1 = total %d count %d", unfilteredTotal, len(unfiltered))
	}

	page1, total, err := repo.UserAssetsPage("user-1", 1, 40, UserAssetPageFilter{Status: "active", Generated: true})
	if err != nil {
		t.Fatal(err)
	}
	if total != 125 || len(page1) != 40 {
		t.Fatalf("generated page1 = total %d count %d ids %s", total, len(page1), assetIDs(page1))
	}
	if page1[0].ID != "gen-audio-005" {
		t.Fatalf("generated page1 newest = %s", page1[0].ID)
	}
	for _, item := range page1 {
		if strings.HasPrefix(item.ID, "plain-") || item.ID == "gen-text" || item.ID == "gen-archived" {
			t.Fatalf("generated page included %s", item.ID)
		}
	}

	page2, total, err := repo.UserAssetsPage("user-1", 2, 40, UserAssetPageFilter{Status: "active", Generated: true})
	if err != nil {
		t.Fatal(err)
	}
	if total != 125 || len(page2) != 40 || page2[0].ID != "gen-img-085" {
		t.Fatalf("generated page2 = total %d ids %s", total, assetIDs(page2))
	}
	page4, total, err := repo.UserAssetsPage("user-1", 4, 40, UserAssetPageFilter{Status: "active", Generated: true})
	if err != nil {
		t.Fatal(err)
	}
	if total != 125 || len(page4) != 5 || page4[4].ID != "gen-img-001" {
		t.Fatalf("generated page4 = total %d ids %s", total, assetIDs(page4))
	}
	seen := map[string]bool{}
	for _, item := range append(append(append([]model.Asset{}, page1...), page2...), page4...) {
		if seen[item.ID] {
			t.Fatalf("generated pages overlap on %s", item.ID)
		}
		seen[item.ID] = true
	}
	if !seen["gen-img-001"] {
		t.Fatal("generated records beyond the first unfiltered page were missing")
	}

	images, imageTotal, err := repo.UserAssetsPage("user-1", 1, 40, UserAssetPageFilter{Status: "active", Generated: true, Kind: "image"})
	if err != nil {
		t.Fatal(err)
	}
	if imageTotal != 110 || len(images) != 40 || images[0].Kind != "image" {
		t.Fatalf("generated images = total %d count %d", imageTotal, len(images))
	}

	generatedTotal, kindRows, err := repo.UserAssetGeneratedCounts("user-1")
	if err != nil {
		t.Fatal(err)
	}
	if generatedTotal != 125 {
		t.Fatalf("generated total = %d", generatedTotal)
	}
	kindCounts := facetCountMap(kindRows)
	if kindCounts["image"] != 110 || kindCounts["video"] != 10 || kindCounts["audio"] != 5 || kindCounts["text"] != 0 || len(kindCounts) != 3 {
		t.Fatalf("generated kind counts = %#v", kindCounts)
	}
}

func TestUserAssetProjectCountsUsesActiveNonEntitySemantics(t *testing.T) {
	repo, db := newAssetLibraryTestRepository(t)
	now := time.Now().UTC()
	create := func(asset model.Asset) {
		t.Helper()
		if err := db.Create(&asset).Error; err != nil {
			t.Fatal(err)
		}
	}
	create(model.Asset{
		ID: "named", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
		Title: "海边", PayloadJSON: `{"id":"named","metadata":{"projectName":"海边剧"}}`, CreatedAt: now, UpdatedAt: now,
	})
	create(model.Asset{
		ID: "archived", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusArchived,
		Title: "归档", PayloadJSON: `{"id":"archived","metadata":{"projectName":"归档项目"}}`, CreatedAt: now, UpdatedAt: now,
	})
	create(model.Asset{
		ID: "entity", UserID: "user-1", Kind: "entity", Category: model.AssetCategoryOther, Status: model.AssetVersionStatusConfirmed,
		Title: "角色", PayloadJSON: `{"id":"entity","metadata":{"projectName":"角色项目"}}`, CreatedAt: now, UpdatedAt: now,
	})
	create(model.Asset{
		ID: "plain", UserID: "user-1", Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed,
		Title: "普通", PayloadJSON: `{"id":"plain","metadata":{}}`, CreatedAt: now, UpdatedAt: now,
	})

	rows, err := repo.UserAssetProjectCounts("user-1")
	if err != nil {
		t.Fatal(err)
	}
	got := facetCountMap(rows)
	if got["海边剧"] != 1 || got["未关联项目"] != 1 || got["归档项目"] != 0 || got["角色项目"] != 0 || len(got) != 2 {
		t.Fatalf("active non-entity project counts = %#v", got)
	}
}

func assetIDs(assets []model.Asset) string {
	ids := make([]string, len(assets))
	for index, asset := range assets {
		ids[index] = asset.ID
	}
	return strings.Join(ids, ",")
}

type stringSet map[string]struct{}

func assetIDSet(assets []model.Asset) stringSet {
	result := make(stringSet, len(assets))
	for _, asset := range assets {
		result[asset.ID] = struct{}{}
	}
	return result
}

func (set stringSet) Equal(ids ...string) bool {
	if len(set) != len(ids) {
		return false
	}
	for _, id := range ids {
		if _, ok := set[id]; !ok {
			return false
		}
	}
	return true
}

func facetCountMap(rows []UserAssetFacetRow) map[string]int64 {
	result := make(map[string]int64, len(rows))
	for _, row := range rows {
		result[row.Key] = row.Count
	}
	return result
}
