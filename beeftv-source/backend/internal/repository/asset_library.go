package repository

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

var ErrAssetFolderAssignmentConflict = errors.New("asset folder assignment conflict")

const (
	assetFolderAssignmentAttempts = 3
	userAssetRecentDuration       = 30 * 24 * time.Hour
	userAssetLinkedProjectLabel   = "已关联项目"
	userAssetUnlinkedProjectLabel = "未关联项目"
)

type UserAssetPageFilter struct {
	Kind          string
	Category      string
	FolderID      *string
	Uncategorized bool
	Status        string
	Query         string
	Favorite      bool
	Recent        bool
	Project       string
	ProjectID     string // Verified domain-project relation; distinct from display-label Project.
	Generated     bool
}

type UserAssetFacetRow struct {
	Key   string
	Count int64
}

func (r *Repository) UserAssetsPage(userID string, page int, pageSize int, filter UserAssetPageFilter) ([]model.Asset, int64, error) {
	var assets []model.Asset
	var total int64
	// 素材库页面只展示媒体与文本素材；entity 角色卡由项目资产页管理。列表与 facets 必须同口径排除，
	// 否则 facets 会计入 entity，前端出现“全部计数 30 但列表为空”的矛盾。
	query := userAssetFilteredQuery(r.db.Model(&model.Asset{}).Where("user_id = ? AND kind <> ?", userID, "entity"), filter, true)
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	err := query.Order("updated_at desc, id desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&assets).Error
	return assets, total, err
}

func (r *Repository) UserAssetFacets(userID string, status string) ([]UserAssetFacetRow, []UserAssetFacetRow, []UserAssetFacetRow, error) {
	base := func() *gorm.DB {
		return userAssetFilteredQuery(r.db.Model(&model.Asset{}).Where("user_id = ? AND kind <> ?", userID, "entity"), UserAssetPageFilter{Status: status}, false)
	}
	var kindRows []UserAssetFacetRow
	if err := base().Select("kind AS key, COUNT(*) AS count").Group("kind").Scan(&kindRows).Error; err != nil {
		return nil, nil, nil, err
	}
	var categoryRows []UserAssetFacetRow
	if err := base().Select("category AS key, COUNT(*) AS count").Group("category").Scan(&categoryRows).Error; err != nil {
		return nil, nil, nil, err
	}
	var folderRows []UserAssetFacetRow
	if err := base().Select("folder_id AS key, COUNT(*) AS count").Group("folder_id").Scan(&folderRows).Error; err != nil {
		return nil, nil, nil, err
	}
	return kindRows, categoryRows, folderRows, nil
}

func (r *Repository) UserAssetQuickFilterCounts(userID string) (favorite int64, recent int64, err error) {
	base := func() *gorm.DB {
		return r.db.Model(&model.Asset{}).Where("user_id = ? AND kind <> ?", userID, "entity")
	}
	if err := userAssetFilteredQuery(base(), UserAssetPageFilter{Status: "active", Favorite: true}, false).Count(&favorite).Error; err != nil {
		return 0, 0, err
	}
	if err := userAssetFilteredQuery(base(), UserAssetPageFilter{Status: "active", Recent: true}, false).Count(&recent).Error; err != nil {
		return 0, 0, err
	}
	return favorite, recent, nil
}

func (r *Repository) UserAssetProjectCounts(userID string) ([]UserAssetFacetRow, error) {
	expr := userAssetProjectLabelSQL()
	var rows []UserAssetFacetRow
	err := userAssetFilteredQuery(
		r.db.Model(&model.Asset{}).Where("user_id = ? AND kind <> ?", userID, "entity"),
		UserAssetPageFilter{Status: "active"},
		false,
	).Select(expr + " AS key, COUNT(*) AS count").Group(expr).Scan(&rows).Error
	return rows, err
}

func (r *Repository) UserAssetGeneratedCounts(userID string) (total int64, kindRows []UserAssetFacetRow, err error) {
	base := func() *gorm.DB {
		return userAssetFilteredQuery(
			r.db.Model(&model.Asset{}).Where("user_id = ? AND kind <> ?", userID, "entity"),
			UserAssetPageFilter{Status: "active", Generated: true},
			false,
		)
	}
	if err := base().Count(&total).Error; err != nil {
		return 0, nil, err
	}
	if err := base().Select("kind AS key, COUNT(*) AS count").Group("kind").Scan(&kindRows).Error; err != nil {
		return 0, nil, err
	}
	return total, kindRows, nil
}

func userAssetFilteredQuery(query *gorm.DB, filter UserAssetPageFilter, includeSearch bool) *gorm.DB {
	if value := strings.TrimSpace(filter.Kind); value != "" {
		query = query.Where("kind = ?", value)
	}
	if value := strings.TrimSpace(filter.Category); value != "" {
		query = query.Where("category = ?", value)
	}
	if filter.Uncategorized {
		query = query.Where("folder_id = ''")
	} else if filter.FolderID != nil {
		query = query.Where("folder_id = ?", strings.TrimSpace(*filter.FolderID))
	}
	switch strings.TrimSpace(filter.Status) {
	case "active":
		query = query.Where("status <> ?", model.AssetVersionStatusArchived)
	case "archived":
		query = query.Where("status = ?", model.AssetVersionStatusArchived)
	case "":
	default:
		query = query.Where("status = ?", strings.TrimSpace(filter.Status))
	}
	if includeSearch {
		if value := strings.ToLower(strings.TrimSpace(filter.Query)); value != "" {
			pattern := "%" + value + "%"
			query = query.Where("LOWER(title) LIKE ? OR LOWER(payload_json) LIKE ?", pattern, pattern)
		}
	}
	if filter.Favorite {
		query = query.Where("json_extract(payload_json, '$.metadata.favorite') IN (1, 'true', '1')")
	}
	if filter.Recent {
		query = query.Where("updated_at >= ?", time.Now().UTC().Add(-userAssetRecentDuration))
	}
	if value := strings.TrimSpace(filter.Project); value != "" {
		query = query.Where(userAssetProjectLabelSQL()+" = ?", value)
	}
	if value := strings.TrimSpace(filter.ProjectID); value != "" {
		query = query.Where("EXISTS (SELECT 1 FROM project_asset_links WHERE project_asset_links.asset_id = assets.id AND project_asset_links.project_id = ?)", value)
	}
	if filter.Generated {
		query = query.Where(userAssetGeneratedSQL())
	}
	return query
}

func userAssetGeneratedSQL() string {
	return `(kind IN ('image','video','audio') AND (
		json_extract(payload_json, '$.source') = '生成任务'
		OR json_type(payload_json, '$.metadata.generationEffectKey') = 'text'
	))`
}

func userAssetProjectLabelSQL() string {
	return `CASE
		WHEN TRIM(COALESCE(CAST(json_extract(payload_json, '$.metadata.projectName') AS TEXT), '')) != ''
			THEN TRIM(CAST(json_extract(payload_json, '$.metadata.projectName') AS TEXT))
		WHEN COALESCE(json_array_length(payload_json, '$.metadata.projectIds'), 0) > 0
			THEN '` + userAssetLinkedProjectLabel + `'
		ELSE '` + userAssetUnlinkedProjectLabel + `'
	END`
}

func (r *Repository) AssetFolders(userID string) ([]model.AssetFolder, error) {
	var folders []model.AssetFolder
	err := r.db.Where("user_id = ?", userID).Order("position asc, created_at asc").Find(&folders).Error
	return folders, err
}

func (r *Repository) AssetFolderForUser(userID string, folderID string) (*model.AssetFolder, error) {
	var folder model.AssetFolder
	if err := r.db.First(&folder, "id = ? AND user_id = ?", folderID, userID).Error; err != nil {
		return nil, err
	}
	return &folder, nil
}

func (r *Repository) AssetFolderNameExists(userID string, nameKey string, excludeID string) (bool, error) {
	query := r.db.Model(&model.AssetFolder{}).Where("user_id = ? AND name_key = ?", userID, nameKey)
	if excludeID != "" {
		query = query.Where("id <> ?", excludeID)
	}
	var count int64
	err := query.Count(&count).Error
	return count > 0, err
}

func (r *Repository) NextAssetFolderPosition(userID string) (int, error) {
	var row struct{ Maximum int }
	err := r.db.Model(&model.AssetFolder{}).Select("COALESCE(MAX(position), -1) AS maximum").Where("user_id = ?", userID).Scan(&row).Error
	return row.Maximum + 1, err
}

func (r *Repository) CreateAssetFolder(folder *model.AssetFolder) error {
	return r.db.Create(folder).Error
}

func (r *Repository) UpdateAssetFolder(folder *model.AssetFolder) error {
	result := r.db.Model(&model.AssetFolder{}).Where("id = ? AND user_id = ?", folder.ID, folder.UserID).Updates(map[string]any{
		"name": folder.Name, "name_key": folder.NameKey, "updated_at": folder.UpdatedAt,
	})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (r *Repository) MoveUserAssetsToFolder(userID string, assetIDs []string, folderID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if strings.TrimSpace(folderID) != "" {
			var folder model.AssetFolder
			if err := tx.First(&folder, "id = ? AND user_id = ?", folderID, userID).Error; err != nil {
				return err
			}
		}
		return moveUserAssetsToFolder(tx, userID, assetIDs, folderID)
	})
}

func (r *Repository) AssignUserAssetFolder(userID, assetID, folderID, payloadJSON string, expectedPayloadJSON string, now time.Time) (bool, error) {
	result := r.db.Model(&model.Asset{}).Where("id = ? AND user_id = ? AND payload_json = ?", assetID, userID, expectedPayloadJSON).Updates(map[string]any{
		"folder_id": folderID, "payload_json": payloadJSON, "updated_at": now,
	})
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected == 1, nil
}

func (r *Repository) DeleteAssetFolder(userID string, folderID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var folder model.AssetFolder
		if err := tx.First(&folder, "id = ? AND user_id = ?", folderID, userID).Error; err != nil {
			return err
		}
		var assets []model.Asset
		if err := tx.Where("user_id = ? AND folder_id = ?", userID, folderID).Find(&assets).Error; err != nil {
			return err
		}
		ids := make([]string, len(assets))
		for index := range assets {
			ids[index] = assets[index].ID
		}
		if err := moveUserAssetsToFolder(tx, userID, ids, ""); err != nil {
			return err
		}
		result := tx.Delete(&model.AssetFolder{}, "id = ? AND user_id = ?", folderID, userID)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return nil
	})
}

func moveUserAssetsToFolder(tx *gorm.DB, userID string, assetIDs []string, folderID string) error {
	if len(assetIDs) == 0 {
		return nil
	}
	var assets []model.Asset
	if err := tx.Where("user_id = ? AND id IN ?", userID, assetIDs).Find(&assets).Error; err != nil {
		return err
	}
	if len(assets) != len(assetIDs) {
		return gorm.ErrRecordNotFound
	}
	for index := range assets {
		if err := assignAssetFolder(tx, userID, assets[index], folderID); err != nil {
			return err
		}
	}
	return nil
}

func assignAssetFolder(tx *gorm.DB, userID string, item model.Asset, folderID string) error {
	current := item
	for attempt := 0; attempt < assetFolderAssignmentAttempts; attempt++ {
		now := time.Now().UTC()
		payloadJSON, err := assetPayloadWithFolder(current.PayloadJSON, folderID, now)
		if err != nil {
			return err
		}
		result := tx.Model(&model.Asset{}).Where("id = ? AND user_id = ? AND payload_json = ?", current.ID, userID, current.PayloadJSON).Updates(map[string]any{
			"folder_id": folderID, "payload_json": payloadJSON, "updated_at": now,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 1 {
			return nil
		}
		if err := tx.Where("id = ? AND user_id = ?", current.ID, userID).First(&current).Error; err != nil {
			return err
		}
	}
	return ErrAssetFolderAssignmentConflict
}

func assetPayloadWithFolder(payloadJSON string, folderID string, updatedAt time.Time) (string, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return "", err
	}
	if folderID == "" {
		delete(payload, "folderId")
	} else {
		payload["folderId"] = folderID
	}
	payload["updatedAt"] = updatedAt.Format(time.RFC3339Nano)
	encoded, err := json.Marshal(payload)
	return string(encoded), err
}

func IsAssetFolderNotFound(err error) bool {
	return errors.Is(err, gorm.ErrRecordNotFound)
}
