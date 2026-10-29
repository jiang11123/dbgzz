package repository

import "infinite-canvas/backend/internal/model"

func (r *Repository) SetGenerationDeliveryStage(userID, taskID, stage string) error {
	result := r.db.Model(&model.Task{}).Where("id = ? AND user_id = ? AND status = ?", taskID, userID, model.TaskStatusSucceeded).Update("stage", stage)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	return nil
}

func (r *Repository) FinishGenerationDelivery(userID, taskID, previousInput, publicInput string) error {
	result := r.db.Model(&model.Task{}).Where("id = ? AND user_id = ? AND status = ? AND input_json = ?", taskID, userID, model.TaskStatusSucceeded, previousInput).
		Updates(map[string]any{"stage": "生成完成", "input_json": publicInput})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	return nil
}
