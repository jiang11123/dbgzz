package repository

import "infinite-canvas/backend/internal/model"

// Only output representations owned through both the task and asset are
// eligible. Resources are independently owner-scoped before local inspection.
func (r *Repository) DiagnosticResources(userID string, taskIDs []string) ([]model.AssetRepresentation, []model.AssetVersion, []model.Resource, error) {
	if len(taskIDs) == 0 {
		return nil, nil, nil, nil
	}
	var representations []model.AssetRepresentation
	err := r.db.Model(&model.AssetRepresentation{}).
		Select("asset_representations.id", "asset_representations.task_id", "asset_representations.resource_id", "asset_representations.asset_version_id").
		Joins("JOIN tasks ON tasks.id = asset_representations.task_id AND tasks.user_id = ?", userID).
		Joins("JOIN asset_versions ON asset_versions.id = asset_representations.asset_version_id").
		Joins("JOIN assets ON assets.id = asset_versions.asset_id AND assets.user_id = ?", userID).
		Where("asset_representations.task_id IN ?", taskIDs).
		Order("asset_representations.id asc").Limit(1001).Find(&representations).Error
	if err != nil {
		return nil, nil, nil, err
	}
	ids := make([]string, 0, len(representations))
	versionIDs := make([]string, 0, len(representations))
	for _, representation := range representations {
		ids = append(ids, representation.ResourceID)
		versionIDs = append(versionIDs, representation.AssetVersionID)
	}
	var versions []model.AssetVersion
	if len(versionIDs) > 0 {
		err = r.db.Model(&model.AssetVersion{}).Select("asset_versions.id", "asset_versions.asset_id").Joins("JOIN assets ON assets.id = asset_versions.asset_id AND assets.user_id = ?", userID).Where("asset_versions.id IN ?", versionIDs).Find(&versions).Error
		if err != nil {
			return nil, nil, nil, err
		}
	}
	var resources []model.Resource
	if len(ids) > 0 {
		err = r.db.Select("id", "provider", "object_key", "kind", "status", "size", "playback_status").Where("user_id = ? AND id IN ?", userID, ids).Find(&resources).Error
	}
	return representations, versions, resources, err
}
