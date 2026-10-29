package app

import (
	"infinite-canvas/backend/internal/model"
	localproject "infinite-canvas/backend/internal/project"
)

type CreateProjectShotRequest = localproject.CreateProjectShotRequest
type ShotRevisionInput = localproject.ShotRevisionInput
type ReplaceProjectUnitShotsRequest = localproject.ReplaceProjectUnitShotsRequest
type ReplaceProjectUnitShotInput = localproject.ReplaceProjectUnitShotInput
type LinkShotAssetRequest = localproject.LinkShotAssetRequest
type AssetCandidateInput = localproject.AssetCandidateInput
type CreateAssetCandidatesRequest = localproject.CreateAssetCandidatesRequest

const assetCandidateSourceChapterCharacter = localproject.AssetCandidateSourceChapterCharacter

func (s *Service) CreateProjectShot(userID string, projectID string, req CreateProjectShotRequest) (model.Shot, error) {
	return s.projectDomain().CreateProjectShot(userID, projectID, req)
}

func (s *Service) ReplaceProjectUnitShots(userID string, projectID string, unitID string, req ReplaceProjectUnitShotsRequest) ([]model.Shot, error) {
	return s.projectDomain().ReplaceProjectUnitShots(userID, projectID, unitID, req)
}

func (s *Service) CreateShotRevision(userID string, projectID string, shotID string, input ShotRevisionInput) (model.Shot, model.ShotRevision, error) {
	return s.projectDomain().CreateShotRevision(userID, projectID, shotID, input)
}

func (s *Service) DeleteProjectShot(userID string, projectID string, shotID string) error {
	return s.projectDomain().DeleteProjectShot(userID, projectID, shotID)
}

func (s *Service) LinkShotAsset(userID string, projectID string, shotID string, req LinkShotAssetRequest) (model.ShotAssetReference, error) {
	return s.projectDomain().LinkShotAsset(userID, projectID, shotID, req)
}

func (s *Service) UnlinkShotAsset(userID string, projectID string, shotID string, referenceID string) error {
	return s.projectDomain().UnlinkShotAsset(userID, projectID, shotID, referenceID)
}

func (s *Service) CreateProjectAssetCandidates(userID string, projectID string, req CreateAssetCandidatesRequest) ([]model.ProjectAssetCandidate, error) {
	return s.projectDomain().CreateProjectAssetCandidates(userID, projectID, req)
}

func (s *Service) ChapterApplyReceipts(userID string, projectID string, taskIDs []string) ([]localproject.ChapterApplyReceiptView, error) {
	return s.projectDomain().ChapterApplyReceipts(userID, projectID, taskIDs)
}
