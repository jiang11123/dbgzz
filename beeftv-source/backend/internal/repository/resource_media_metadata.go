package repository

import (
	"context"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

// A probe must not overwrite playback/ingest state or recreate a deleted row.
func (r *Repository) UpdateResourceMediaMetadata(ctx context.Context, resource *model.Resource) error {
	result := r.db.WithContext(ctx).Model(&model.Resource{}).
		Where("id = ? AND user_id = ? AND status = ? AND object_key = ?", resource.ID, resource.UserID, model.ResourceStatusReady, resource.ObjectKey).
		Updates(map[string]any{
			"duration_ms": gorm.Expr("CASE WHEN COALESCE(duration_ms, 0) <= 0 THEN ? ELSE duration_ms END", resource.DurationMs),
			"width":       gorm.Expr("CASE WHEN COALESCE(width, 0) <= 0 THEN ? ELSE width END", resource.Width),
			"height":      gorm.Expr("CASE WHEN COALESCE(height, 0) <= 0 THEN ? ELSE height END", resource.Height),
			"updated_at":  resource.UpdatedAt,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
