package repository

import (
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func (r *Repository) AgentOpRecordsForUser(userID string, opIDs []string) ([]model.AgentOpRecord, error) {
	if len(opIDs) == 0 {
		return nil, nil
	}
	var records []model.AgentOpRecord
	err := r.db.Where("user_id = ? AND op_id IN ? AND status = ?", userID, opIDs, "succeeded").Find(&records).Error
	return records, err
}

func (r *Repository) ReplaceProjectUnitShotsTx(tx *gorm.DB, userID, projectID, unitID string, shots []model.Shot, revisions []model.ShotRevision, references []model.ShotAssetReference, expectedShotIDs []string, expectedShotPointers map[string]string, expectedRevision int64) error {
	return replaceProjectUnitShotsTx(tx, userID, projectID, unitID, shots, revisions, references, expectedShotIDs, expectedShotPointers, expectedRevision)
}

func (r *Repository) CreateProjectAssetCandidatesAndBumpTx(tx *gorm.DB, userID, projectID string, candidates []model.ProjectAssetCandidate) ([]model.ProjectAssetCandidate, error) {
	return createProjectAssetCandidatesAndBumpTx(tx, userID, projectID, candidates)
}
