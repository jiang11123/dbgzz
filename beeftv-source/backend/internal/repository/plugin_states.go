package repository

import (
	"errors"
	"strings"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *Repository) PluginPlatformState(pluginID string) (*model.PluginPlatformState, error) {
	var state model.PluginPlatformState
	if err := r.db.First(&state, "plugin_id = ?", pluginID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &state, nil
}

func (r *Repository) PluginPlatformStates() ([]model.PluginPlatformState, error) {
	var states []model.PluginPlatformState
	err := r.db.Order("plugin_id asc").Find(&states).Error
	return states, err
}

func (r *Repository) SavePluginPlatformState(state *model.PluginPlatformState) error {
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "plugin_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"available", "updated_by", "updated_at"}),
	}).Create(state).Error
}

func (r *Repository) DeletePluginPlatformState(pluginID string) error {
	return r.db.Delete(&model.PluginPlatformState{}, "plugin_id = ?", pluginID).Error
}

func (r *Repository) DeletePluginStates(pluginID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&model.UserPluginState{}, "plugin_id = ?", pluginID).Error; err != nil {
			return err
		}
		return tx.Delete(&model.PluginPlatformState{}, "plugin_id = ?", pluginID).Error
	})
}

func (r *Repository) LookupSystemSetting(key string) (*model.SystemSetting, error) {
	var setting model.SystemSetting
	if err := r.db.First(&setting, "key = ?", key).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &setting, nil
}

// CommitPluginRegistry writes the namespaced plugin registry setting together
// with optional platform upsert or user/platform state removal.
func (r *Repository) CommitPluginRegistry(settingKey, valueJSON string, platform *model.PluginPlatformState, deletePluginID string) error {
	if strings.TrimSpace(settingKey) == "" {
		return errors.New("plugin registry setting key is empty")
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		setting := &model.SystemSetting{Key: settingKey, ValueJSON: valueJSON}
		if err := tx.Save(setting).Error; err != nil {
			return err
		}
		if deletePluginID != "" {
			if err := tx.Delete(&model.UserPluginState{}, "plugin_id = ?", deletePluginID).Error; err != nil {
				return err
			}
			if err := tx.Delete(&model.PluginPlatformState{}, "plugin_id = ?", deletePluginID).Error; err != nil {
				return err
			}
		}
		if platform != nil {
			if err := tx.Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "plugin_id"}},
				DoUpdates: clause.AssignmentColumns([]string{"available", "updated_by", "updated_at"}),
			}).Create(platform).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *Repository) UserPluginState(userID string, pluginID string) (*model.UserPluginState, error) {
	var state model.UserPluginState
	if err := r.db.First(&state, "user_id = ? AND plugin_id = ?", userID, pluginID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &state, nil
}

func (r *Repository) UserPluginStates(userID string) ([]model.UserPluginState, error) {
	var states []model.UserPluginState
	err := r.db.Where("user_id = ?", userID).Order("plugin_id asc").Find(&states).Error
	return states, err
}

func (r *Repository) SaveUserPluginState(state *model.UserPluginState) error {
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}, {Name: "plugin_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"enabled", "updated_at"}),
	}).Create(state).Error
}

func (r *Repository) DeleteUserPluginStates(pluginID string) error {
	return r.db.Delete(&model.UserPluginState{}, "plugin_id = ?", pluginID).Error
}

func (r *Repository) EnabledPluginUserCounts() (map[string]int64, error) {
	type countRow struct {
		PluginID string
		Count    int64
	}
	var rows []countRow
	if err := r.db.Model(&model.UserPluginState{}).
		Select("plugin_id, COUNT(*) AS count").
		Where("enabled = ?", true).
		Group("plugin_id").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	result := make(map[string]int64, len(rows))
	for _, row := range rows {
		result[row.PluginID] = row.Count
	}
	return result, nil
}
