package repository

import (
	"errors"
	"strings"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *Repository) creationConversationDB(tx *gorm.DB) *gorm.DB {
	if tx != nil {
		return tx
	}
	if r == nil {
		return nil
	}
	return r.db
}

func (r *Repository) CreationConversation(tx *gorm.DB, userID, conversationID string) (*model.CreationConversation, error) {
	db := r.creationConversationDB(tx)
	if db == nil {
		return nil, errors.New("创作对话存储不可用")
	}
	var row model.CreationConversation
	err := db.Where("user_id = ? AND conversation_id = ?", strings.TrimSpace(userID), strings.TrimSpace(conversationID)).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *Repository) CreationConversationByImportOperation(tx *gorm.DB, userID, operationID string) (*model.CreationConversation, error) {
	db := r.creationConversationDB(tx)
	if db == nil {
		return nil, errors.New("创作对话存储不可用")
	}
	operationID = strings.TrimSpace(operationID)
	if operationID == "" {
		return nil, gorm.ErrRecordNotFound
	}
	var row model.CreationConversation
	err := db.Where("user_id = ? AND import_operation_id = ?", strings.TrimSpace(userID), operationID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *Repository) ListCreationConversations(tx *gorm.DB, userID string) ([]model.CreationConversation, error) {
	db := r.creationConversationDB(tx)
	if db == nil {
		return nil, errors.New("创作对话存储不可用")
	}
	var rows []model.CreationConversation
	err := db.Where("user_id = ? AND deleted = ?", strings.TrimSpace(userID), false).
		Order("updated_at DESC").
		Find(&rows).Error
	return rows, err
}

func (r *Repository) ListDeletedCreationConversationIDs(tx *gorm.DB, userID string) ([]string, error) {
	db := r.creationConversationDB(tx)
	if db == nil {
		return nil, errors.New("创作对话存储不可用")
	}
	var rows []model.CreationConversation
	if err := db.Select("conversation_id").
		Where("user_id = ? AND deleted = ?", strings.TrimSpace(userID), true).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ConversationID)
	}
	return ids, nil
}

func (r *Repository) InsertCreationConversation(tx *gorm.DB, row *model.CreationConversation) (bool, error) {
	db := r.creationConversationDB(tx)
	if db == nil {
		return false, errors.New("创作对话存储不可用")
	}
	result := db.Clauses(clause.OnConflict{DoNothing: true}).Create(row)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected == 1, nil
}

func (r *Repository) CompareAndSwapCreationConversation(tx *gorm.DB, userID, conversationID string, expectedRevision int64, next *model.CreationConversation) (bool, error) {
	db := r.creationConversationDB(tx)
	if db == nil {
		return false, errors.New("创作对话存储不可用")
	}
	if next == nil {
		return false, errors.New("创作对话内容无效")
	}
	result := db.Model(&model.CreationConversation{}).
		Where("user_id = ? AND conversation_id = ? AND revision = ?", strings.TrimSpace(userID), strings.TrimSpace(conversationID), expectedRevision).
		Updates(map[string]any{
			"revision":            next.Revision,
			"document":            next.Document,
			"deleted":             next.Deleted,
			"import_operation_id": next.ImportOperationID,
			"import_hash":         next.ImportHash,
			"updated_at":          next.UpdatedAt,
		})
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected == 1, nil
}
