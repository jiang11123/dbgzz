package repository

import (
	"errors"
	"strings"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

var (
	ErrTaskScopeNotActive = errors.New("task scope is not active")
	ErrTaskScopeArchived  = errors.New("task scope is archived")
)

// RequireTaskScopeActiveTx is the admission-side canvas/project counterpart of
// CreateTaskWithActiveLimit and RetryTask. Lead must call it in the same write
// transaction as the task insert or retry, after client-operation replay and
// before Create/Updates.
//
// Empty ProjectID stays allowed for standalone text/media. A nonempty id must
// be an owned personal canvas or an owned active business project. A canvas
// linked to a business project re-checks that project's active ownership here.
// Unknown, foreign, deleted, and archived ids fail closed; an unknown id is
// not admitted merely because it is not a business project.
//
// The no-op UPDATE takes SQLite's writer lock so WAL cannot commit an archive
// or delete between the check and the task write. A plain SELECT is not
// enough: WAL readers do not block BEGIN IMMEDIATE.
func RequireTaskScopeActiveTx(tx *gorm.DB, userID, canvasOrProjectID string) error {
	if tx == nil {
		return gorm.ErrInvalidDB
	}
	id := strings.TrimSpace(canvasOrProjectID)
	if id == "" {
		return nil
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return ErrTaskScopeNotActive
	}
	if err := lockOwnedRowTx(tx, &model.CanvasProject{}, userID, id); err != nil {
		return err
	}
	var canvas model.CanvasProject
	err := tx.Select("id", "project_id").Where("user_id = ? AND id = ?", userID, id).First(&canvas).Error
	if err == nil {
		linked := strings.TrimSpace(canvas.ProjectID)
		if linked == "" {
			return nil
		}
		return requireOwnedActiveProjectTx(tx, userID, linked)
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	return requireOwnedActiveProjectTx(tx, userID, id)
}

func (r *Repository) RequireTaskScopeActive(userID, canvasOrProjectID string) error {
	if r == nil || r.db == nil {
		return gorm.ErrInvalidDB
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		return RequireTaskScopeActiveTx(tx, userID, canvasOrProjectID)
	})
}

func requireOwnedActiveProjectTx(tx *gorm.DB, userID, projectID string) error {
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return ErrTaskScopeNotActive
	}
	if err := lockOwnedRowTx(tx, &model.Project{}, userID, projectID); err != nil {
		return err
	}
	var project model.Project
	err := tx.Select("id", "status").Where("user_id = ? AND id = ?", userID, projectID).First(&project).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrTaskScopeNotActive
	}
	if err != nil {
		return err
	}
	if project.Status == model.ProjectStatusArchived {
		return ErrTaskScopeArchived
	}
	if project.Status != model.ProjectStatusActive {
		return ErrTaskScopeNotActive
	}
	return nil
}

func lockOwnedRowTx(tx *gorm.DB, value any, userID, id string) error {
	return tx.Model(value).Where("user_id = ? AND id = ?", userID, id).UpdateColumn("id", gorm.Expr("id")).Error
}
