package repository

import (
	"errors"
	"strings"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *Repository) assistantTurnDB(tx *gorm.DB) *gorm.DB {
	if tx != nil {
		return tx
	}
	if r == nil {
		return nil
	}
	return r.db
}

func (r *Repository) AssistantTurnByID(tx *gorm.DB, turnID string) (*model.AssistantTurn, error) {
	db := r.assistantTurnDB(tx)
	if db == nil {
		return nil, errors.New("助手回合存储不可用")
	}
	var row model.AssistantTurn
	err := db.Where("turn_id = ?", strings.TrimSpace(turnID)).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *Repository) InsertAssistantTurn(tx *gorm.DB, row *model.AssistantTurn) (inserted bool, err error) {
	db := r.assistantTurnDB(tx)
	if db == nil {
		return false, errors.New("助手回合存储不可用")
	}
	result := db.Clauses(clause.OnConflict{DoNothing: true}).Create(row)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected == 1, nil
}

func (r *Repository) SaveAssistantTurn(tx *gorm.DB, row *model.AssistantTurn) error {
	db := r.assistantTurnDB(tx)
	if db == nil {
		return errors.New("助手回合存储不可用")
	}
	// Only explicit intent invalidation writes this monotonic fence. A delayed
	// settlement or replay must not restore a previously cancelled source intent.
	return db.Omit("ContinuationInvalidated", "GenerationAuthorizationJSON").Save(row).Error
}

func (r *Repository) CompactAssistantTurnDocuments(tx *gorm.DB, turnIDs []string) error {
	if len(turnIDs) == 0 {
		return nil
	}
	db := r.assistantTurnDB(tx)
	if db == nil {
		return errors.New("助手回合存储不可用")
	}
	return db.Model(&model.AssistantTurn{}).
		Where("turn_id IN ? AND state <> ? AND TRIM(COALESCE(document, '')) <> ''", turnIDs, "open").
		Where("NOT EXISTS (SELECT 1 FROM agent_op_records WHERE agent_op_records.turn_id = assistant_turns.turn_id)").
		Update("document", "").Error
}

func (r *Repository) ListPrunableAssistantTurns(tx *gorm.DB, retain int) ([]string, error) {
	db := r.assistantTurnDB(tx)
	if db == nil {
		return nil, errors.New("助手回合存储不可用")
	}
	if retain < 0 {
		retain = 0
	}
	var rows []model.AssistantTurn
	if err := db.Select("turn_id", "created_at").
		Where("state <> ?", "open").
		Where("TRIM(COALESCE(document, '')) <> ''").
		Where("NOT EXISTS (SELECT 1 FROM agent_op_records WHERE agent_op_records.turn_id = assistant_turns.turn_id)").
		Order("created_at DESC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) <= retain {
		return nil, nil
	}
	out := make([]string, 0, len(rows)-retain)
	for _, row := range rows[retain:] {
		out = append(out, row.TurnID)
	}
	return out, nil
}

func (r *Repository) CountAgentOpReceiptsByTurn(tx *gorm.DB, turnID string) (int64, error) {
	db := r.assistantTurnDB(tx)
	if db == nil {
		return 0, errors.New("助手操作回执不可用")
	}
	var count int64
	err := db.Model(&model.AgentOpRecord{}).Where("turn_id = ?", strings.TrimSpace(turnID)).Count(&count).Error
	return count, err
}

func (r *Repository) SucceededAgentOpsByTurn(tx *gorm.DB, userID, turnID string) ([]model.AgentOpRecord, error) {
	db := r.assistantTurnDB(tx)
	if db == nil {
		return nil, errors.New("助手操作回执不可用")
	}
	var rows []model.AgentOpRecord
	err := db.Where("user_id = ? AND turn_id = ? AND status = ?", userID, turnID, "succeeded").Find(&rows).Error
	return rows, err
}

func (r *Repository) AgentOpsByIDs(tx *gorm.DB, userID string, ids []string) ([]model.AgentOpRecord, error) {
	db := r.assistantTurnDB(tx)
	if db == nil {
		return nil, errors.New("助手操作回执不可用")
	}
	if len(ids) == 0 {
		return nil, nil
	}
	var rows []model.AgentOpRecord
	err := db.Where("user_id = ? AND op_id IN ?", userID, ids).Find(&rows).Error
	return rows, err
}
