package repository

import (
	"time"

	"infinite-canvas/backend/internal/model"
)

// Deliberately select no transcript, snapshot, prompt, document or tool args.
func (r *Repository) DiagnosticAssistantTurns(userID string, from, to time.Time, canvasID, taskID string) ([]model.AssistantTurn, error) {
	var turns []model.AssistantTurn
	query := r.db.Model(&model.AssistantTurn{}).Select("turn_id", "durable_session_id", "canvas_id", "state", "revision_before", "created_at", "updated_at", "undone", "continuation_invalidated").
		Where("user_id = ?", userID).
		Where("(julianday(created_at) BETWEEN julianday(?) AND julianday(?)) OR (julianday(updated_at) BETWEEN julianday(?) AND julianday(?))", from, to, from, to)
	if canvasID != "" {
		query = query.Where("canvas_id = ?", canvasID)
	}
	if taskID != "" {
		// JSON membership avoids a substring match against unrelated task IDs.
		query = query.Where("EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(associated_task_ids) THEN associated_task_ids ELSE '[]' END) WHERE value = ?)", taskID)
	}
	err := query.Order("MAX(julianday(created_at), julianday(updated_at)) DESC").Order("turn_id DESC").Limit(101).Find(&turns).Error
	return turns, err
}
