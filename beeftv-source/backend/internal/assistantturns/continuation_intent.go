package assistantturns

import (
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

// StopContinuationsForIntent freezes running host identities before any HTTP
// cancellation. Host /complete may finalize a turn before /cancel returns; its
// acknowledgement must not erase the outstanding stop after a lost response.
func (s *Service) StopContinuationsForIntent(userID, canvasID, sessionID string) ([]ContinuationView, error) {
	var rows []model.AssistantContinuation
	err := s.store.DB().Transaction(func(tx *gorm.DB) error {
		if err := s.cancelContinuations(tx, userID, canvasID, sessionID, "", true); err != nil {
			return err
		}
		query := tx.Model(&model.AssistantContinuation{}).Where("user_id = ? AND canvas_id = ? AND state = ?", userID, canvasID, "running")
		if sessionID != "" {
			query = query.Where("session_id = ?", sessionID)
		}
		if err := query.Updates(map[string]any{"state": "stopping", "revision": gorm.Expr("revision + 1"), "updated_at": s.now()}).Error; err != nil {
			return err
		}
		query = tx.Where("user_id = ? AND canvas_id = ? AND state = ?", userID, canvasID, "stopping")
		if sessionID != "" {
			query = query.Where("session_id = ?", sessionID)
		}
		return query.Order("created_at ASC").Find(&rows).Error
	})
	if err != nil {
		return nil, err
	}
	views := make([]ContinuationView, 0, len(rows))
	for _, row := range rows {
		views = append(views, continuationView(row))
	}
	return views, nil
}

func (s *Service) AcknowledgeContinuationStop(userID, id string) error {
	return s.store.DB().Transaction(func(tx *gorm.DB) error {
		var row model.AssistantContinuation
		if err := tx.First(&row, "id = ? AND user_id = ?", id, userID).Error; err != nil {
			return err
		}
		if row.State == "cancelled" {
			return nil
		}
		if row.State != "stopping" {
			return continuationError("conflict")
		}
		if err := tx.Model(&row).Updates(map[string]any{"state": "cancelled", "revision": gorm.Expr("revision + 1"), "updated_at": s.now()}).Error; err != nil {
			return err
		}
		return tx.Model(&model.AssistantTurn{}).Where("turn_id = ? AND user_id = ?", row.TurnID, userID).Update("state", StateSettled).Error
	})
}
