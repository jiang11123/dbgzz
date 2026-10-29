package repository

import (
	"errors"
	"infinite-canvas/backend/internal/model"
	"slices"
	"time"

	"gorm.io/gorm"
)

var ErrChannelOrderChanged = errors.New("列表已发生变化，请重新打开排序后再保存")

// 全量顺序在事务中保存；拒绝过期快照，避免覆盖另一管理员的调整。
func (r *Repository) SaveChannelOrder(channelID string, ids, expected []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var current []string
		var target any = &model.ModelChannel{}
		query := tx.Model(target).Where("scope = ?", model.ChannelScopeSystem)
		if channelID != "" {
			if err := r.lockSystemChannelForModelMutation(tx, channelID); err != nil {
				return err
			}
			target = &model.ChannelModel{}
			query = tx.Model(target).Where("channel_id = ?", channelID)
		}
		if err := query.Order("sort_order asc, created_at asc, id asc").Pluck("id", &current).Error; err != nil {
			return err
		}
		if !slices.Equal(current, expected) || len(ids) != len(current) {
			return ErrChannelOrderChanged
		}
		allowed := make(map[string]bool, len(current))
		for _, id := range current {
			allowed[id] = true
		}
		for _, id := range ids {
			if !allowed[id] {
				return ErrChannelOrderChanged
			}
			delete(allowed, id)
		}
		now := time.Now()
		for index, id := range ids {
			if err := tx.Model(target).Where("id = ?", id).Updates(map[string]any{"sort_order": index, "updated_at": now}).Error; err != nil {
				return err
			}
		}
		if channelID != "" {
			return refreshChannelModelNames(tx, channelID, now)
		}
		return nil
	})
}
