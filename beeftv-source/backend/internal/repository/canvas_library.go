package repository

import (
	"errors"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrCanvasLibraryFolderMissing = errors.New("canvas library folder missing")
	ErrCanvasLibraryFolderDeleted = errors.New("canvas library folder deleted")
	ErrCanvasDrawingDeleted       = errors.New("canvas drawing deleted")
)

func liveCanvasLibraryFolders(db *gorm.DB) *gorm.DB {
	return db.Where("deleted_at IS NULL")
}

func liveCanvasDrawings(db *gorm.DB) *gorm.DB {
	return db.Where("deleted_at IS NULL")
}

func (r *Repository) CanvasLibraryFolders(userID string) ([]model.CanvasLibraryFolder, error) {
	var folders []model.CanvasLibraryFolder
	err := liveCanvasLibraryFolders(r.db).Where("user_id = ?", userID).Order("updated_at desc, created_at desc").Find(&folders).Error
	return folders, err
}

func (r *Repository) CanvasLibraryFolderForUser(userID, id string) (*model.CanvasLibraryFolder, error) {
	var folder model.CanvasLibraryFolder
	if err := liveCanvasLibraryFolders(r.db).First(&folder, "id = ? AND user_id = ?", id, userID).Error; err != nil {
		return nil, err
	}
	return &folder, nil
}

func (r *Repository) CanvasLibraryFolderIncludingDeleted(userID, id string) (*model.CanvasLibraryFolder, error) {
	var folder model.CanvasLibraryFolder
	if err := r.db.Unscoped().First(&folder, "id = ? AND user_id = ?", id, userID).Error; err != nil {
		return nil, err
	}
	return &folder, nil
}

func (r *Repository) CanvasProjectsInLibraryFolder(userID, folderID string) ([]model.CanvasProject, error) {
	var projects []model.CanvasProject
	err := r.db.Where("user_id = ? AND library_folder_id = ?", userID, folderID).Order("id").Find(&projects).Error
	return projects, err
}

func (r *Repository) UpsertCanvasLibraryFolder(folder *model.CanvasLibraryFolder) error {
	existing, err := r.CanvasLibraryFolderIncludingDeleted(folder.UserID, folder.ID)
	if err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		return r.db.Create(folder).Error
	}
	if existing.TombstonedAt != nil {
		return ErrCanvasLibraryFolderDeleted
	}
	result := liveCanvasLibraryFolders(r.db.Model(&model.CanvasLibraryFolder{})).Where("id = ? AND user_id = ?", folder.ID, folder.UserID).Updates(map[string]any{
		"name": folder.Name, "cover_resource_id": folder.CoverResourceID, "updated_at": folder.UpdatedAt,
	})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	folder.CreatedAt = existing.CreatedAt
	return nil
}

func (r *Repository) TombstoneCanvasLibraryFolder(userID, id string, at time.Time) error {
	result := liveCanvasLibraryFolders(r.db.Model(&model.CanvasLibraryFolder{})).Where("id = ? AND user_id = ?", id, userID).Updates(map[string]any{
		"cover_resource_id": "", "deleted_at": at, "updated_at": at,
	})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 1 {
		return nil
	}
	existing, err := r.CanvasLibraryFolderIncludingDeleted(userID, id)
	if err != nil {
		return err
	}
	if existing.TombstonedAt != nil {
		return nil
	}
	return gorm.ErrRecordNotFound
}

func (r *Repository) CanvasDrawings(userID, canvasID string) ([]model.CanvasDrawing, error) {
	var drawings []model.CanvasDrawing
	err := liveCanvasDrawings(r.db).Select(
		"user_id", "canvas_id", "drawing_id", "engine", "revision", "shape_count", "page_count",
		"preview_resource_id", "render_resource_id", "render_page_id", "render_width", "render_height",
		"render_mime_type", "render_background", "render_storage_key", "created_at", "updated_at",
	).Where("user_id = ? AND canvas_id = ?", userID, canvasID).Order("updated_at desc, drawing_id").Find(&drawings).Error
	return drawings, err
}

func (r *Repository) CanvasDrawingForUser(userID, canvasID, drawingID string) (*model.CanvasDrawing, error) {
	var drawing model.CanvasDrawing
	if err := liveCanvasDrawings(r.db).First(&drawing, "user_id = ? AND canvas_id = ? AND drawing_id = ?", userID, canvasID, drawingID).Error; err != nil {
		return nil, err
	}
	return &drawing, nil
}

func (r *Repository) CanvasDrawingIncludingDeleted(userID, canvasID, drawingID string) (*model.CanvasDrawing, error) {
	var drawing model.CanvasDrawing
	if err := r.db.Unscoped().First(&drawing, "user_id = ? AND canvas_id = ? AND drawing_id = ?", userID, canvasID, drawingID).Error; err != nil {
		return nil, err
	}
	return &drawing, nil
}

func (r *Repository) UpsertCanvasDrawing(drawing *model.CanvasDrawing) error {
	expected := drawing.Revision
	if expected < 0 {
		return ErrCanvasRevisionConflict
	}
	existing, err := r.CanvasDrawingIncludingDeleted(drawing.UserID, drawing.CanvasID, drawing.DrawingID)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	if existing != nil && existing.TombstonedAt != nil {
		return ErrCanvasDrawingDeleted
	}
	if expected == 0 {
		created := *drawing
		created.Revision = 1
		result := r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&created)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrCanvasRevisionConflict
		}
		drawing.Revision = 1
		return nil
	}
	result := liveCanvasDrawings(r.db.Model(&model.CanvasDrawing{})).
		Where("user_id = ? AND canvas_id = ? AND drawing_id = ? AND revision = ?", drawing.UserID, drawing.CanvasID, drawing.DrawingID, expected).
		Updates(map[string]any{
			"engine": drawing.Engine, "snapshot_json": drawing.SnapshotJSON,
			"shape_count": drawing.ShapeCount, "page_count": drawing.PageCount,
			"preview_resource_id": drawing.PreviewResourceID, "render_resource_id": drawing.RenderResourceID,
			"render_page_id": drawing.RenderPageID, "render_width": drawing.RenderWidth, "render_height": drawing.RenderHeight,
			"render_mime_type": drawing.RenderMimeType, "render_background": drawing.RenderBackground,
			"render_storage_key": drawing.RenderStorageKey, "updated_at": drawing.UpdatedAt, "revision": expected + 1,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrCanvasRevisionConflict
	}
	drawing.Revision = expected + 1
	return nil
}

func drawingTombstoneUpdates(at time.Time) map[string]any {
	return map[string]any{
		"snapshot_json": "{}", "shape_count": 0, "page_count": 1,
		"preview_resource_id": "", "render_resource_id": "", "render_page_id": "",
		"render_width": 0, "render_height": 0, "render_mime_type": "",
		"render_background": "", "render_storage_key": "",
		"deleted_at": at, "updated_at": at,
	}
}

func (r *Repository) TombstoneCanvasDrawing(userID, canvasID, drawingID string, at time.Time) error {
	result := liveCanvasDrawings(r.db.Model(&model.CanvasDrawing{})).
		Where("user_id = ? AND canvas_id = ? AND drawing_id = ?", userID, canvasID, drawingID).
		Updates(drawingTombstoneUpdates(at))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 1 {
		return nil
	}
	existing, err := r.CanvasDrawingIncludingDeleted(userID, canvasID, drawingID)
	if err != nil {
		return err
	}
	if existing.TombstonedAt != nil {
		return nil
	}
	return gorm.ErrRecordNotFound
}

func (r *Repository) TombstoneCanvasDrawingsForCanvas(userID, canvasID string, at time.Time) error {
	return liveCanvasDrawings(r.db.Model(&model.CanvasDrawing{})).
		Where("user_id = ? AND canvas_id = ?", userID, canvasID).
		Updates(drawingTombstoneUpdates(at)).Error
}

func (r *Repository) CanvasLibraryResourceReferences(userID string, resourceIDs []string) ([]ResourceDirectReference, error) {
	refs := []ResourceDirectReference{}
	if len(resourceIDs) == 0 {
		return refs, nil
	}
	if r.db.Migrator().HasTable(&model.CanvasDrawing{}) {
		var drawings []model.CanvasDrawing
		if err := liveCanvasDrawings(r.db).Select("canvas_id", "drawing_id", "preview_resource_id", "render_resource_id").
			Where("user_id = ? AND (preview_resource_id IN ? OR render_resource_id IN ?)", userID, resourceIDs, resourceIDs).
			Find(&drawings).Error; err != nil {
			return nil, err
		}
		for _, drawing := range drawings {
			title := drawing.CanvasID + "/" + drawing.DrawingID
			if drawing.PreviewResourceID != "" {
				refs = append(refs, ResourceDirectReference{Kind: "画板预览", ID: drawing.DrawingID, Title: title, ResourceID: drawing.PreviewResourceID})
			}
			if drawing.RenderResourceID != "" {
				refs = append(refs, ResourceDirectReference{Kind: "画板成品", ID: drawing.DrawingID, Title: title, ResourceID: drawing.RenderResourceID})
			}
		}
	}
	if r.db.Migrator().HasTable(&model.CanvasLibraryFolder{}) {
		var folders []model.CanvasLibraryFolder
		if err := liveCanvasLibraryFolders(r.db).Select("id", "name", "cover_resource_id").
			Where("user_id = ? AND cover_resource_id IN ?", userID, resourceIDs).
			Find(&folders).Error; err != nil {
			return nil, err
		}
		for _, folder := range folders {
			refs = append(refs, ResourceDirectReference{Kind: "画布文件夹封面", ID: folder.ID, Title: folder.Name, ResourceID: folder.CoverResourceID})
		}
	}
	return refs, nil
}
