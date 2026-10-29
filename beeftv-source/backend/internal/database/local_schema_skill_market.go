package database

import (
	"fmt"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func migrateSkillMarketReleaseMetadata(tx *gorm.DB) error {
	// Historical workspaces can predate versioned skill packages.
	if !tx.Migrator().HasTable(&model.SkillVersion{}) {
		if err := tx.Migrator().CreateTable(&model.SkillVersion{}); err != nil {
			return err
		}
	}
	if err := ensureSQLiteColumn(tx, "skill_versions", "market_release_json", "TEXT"); err != nil {
		return err
	}
	return requireSkillMarketReleaseMetadata(tx)
}

func requireSkillMarketReleaseMetadata(db *gorm.DB) error {
	has, err := sqliteHasColumn(db, "skill_versions", "market_release_json")
	if err != nil {
		return err
	}
	if !has {
		return fmt.Errorf("本地技能市场版本资料缺失，请启用自动迁移")
	}
	return nil
}
