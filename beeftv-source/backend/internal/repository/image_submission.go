package repository

import (
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
	"time"
)

func (r *Repository) ImageSubmission(attemptID, taskID, userID string) (*model.ImageSubmission, error) {
	var row model.ImageSubmission
	err := r.db.Where("attempt_id = ? AND task_id = ? AND user_id = ?", attemptID, taskID, userID).First(&row).Error
	return &row, err
}

func (r *Repository) CreateImageSubmission(row *model.ImageSubmission) error {
	// Keep an expired identity as a tombstone, but remove potentially large media
	// and encrypted credentials after the gateway's replay retention window.
	if err := r.db.Model(&model.ImageSubmission{}).Where("created_at < ? AND request_cipher <> ?", time.Now().Add(-24*time.Hour), "").Update("request_cipher", "").Error; err != nil {
		return err
	}
	return r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(row).Error
}

func (r *Repository) CreateImageRetry(attempt *model.RouteAttempt, row *model.ImageSubmission) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(attempt).Error; err != nil {
			return err
		}
		return tx.Create(row).Error
	})
}

func (r *Repository) MarkImageSubmissionAccepted(row *model.ImageSubmission) error {
	result := r.db.Model(&model.ImageSubmission{}).Where("attempt_id = ? AND task_id = ? AND user_id = ?", row.AttemptID, row.TaskID, row.UserID).Update("response_accepted", true)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	row.ResponseAccepted = true
	return nil
}

func (r *Repository) ClaimImageSubmissionSend(row *model.ImageSubmission, owner string, maxSends int) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := taskLeaseWriter(tx.Model(&model.Task{}), owner).Where("id = ? AND user_id = ? AND status = ?", row.TaskID, row.UserID, model.TaskStatusRunning).Count(&count).Error; err != nil {
			return err
		}
		if count != 1 {
			return ErrTaskStateConflict
		}
		result := tx.Model(&model.ImageSubmission{}).Where("attempt_id = ? AND send_count = ? AND (send_count < ? OR response_accepted = ?)", row.AttemptID, row.SendCount, maxSends, true).Update("send_count", gorm.Expr("send_count + 1"))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrTaskStateConflict
		}
		row.SendCount++
		return nil
	})
}
