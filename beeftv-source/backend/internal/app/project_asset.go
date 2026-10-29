package app

import (
	"infinite-canvas/backend/internal/model"
	localproject "infinite-canvas/backend/internal/project"
)

const (
	AssetSourceUploaded = localproject.AssetSourceUploaded
	AssetSourceCanvas   = localproject.AssetSourceCanvas
)

type LinkProjectAssetRequest = localproject.LinkProjectAssetRequest
type UpdateProjectAssetRequest = localproject.UpdateProjectAssetRequest
type CreateAssetVersionRequest = localproject.CreateAssetVersionRequest
type ProjectAssetFilter = localproject.ProjectAssetFilter
type ConfirmProjectAssetCandidateRequest = localproject.ConfirmProjectAssetCandidateRequest

func (s *Service) FilterProjectAssets(userID string, projectID string, filter ProjectAssetFilter) ([]ProjectAssetSummary, error) {
	return s.projectDomain().FilterProjectAssets(userID, projectID, filter)
}

func (s *Service) ProjectAssets(userID string, projectID string) ([]ProjectAssetSummary, error) {
	return s.projectDomain().ProjectAssets(userID, projectID)
}

func (s *Service) LinkProjectAsset(userID string, projectID string, req LinkProjectAssetRequest) (ProjectAssetSummary, error) {
	return s.projectDomain().LinkProjectAsset(userID, projectID, req)
}

func (s *Service) UnlinkProjectAsset(userID string, projectID string, assetID string) error {
	return s.projectDomain().UnlinkProjectAsset(userID, projectID, assetID)
}

func (s *Service) UpdateProjectAsset(userID string, projectID string, assetID string, req UpdateProjectAssetRequest) (ProjectAssetSummary, error) {
	return s.projectDomain().UpdateProjectAsset(userID, projectID, assetID, req)
}

func (s *Service) CreateProjectAssetVersion(userID string, projectID string, assetID string, req CreateAssetVersionRequest) (model.AssetVersion, error) {
	return s.projectDomain().CreateProjectAssetVersion(userID, projectID, assetID, req)
}

func (s *Service) ConfirmProjectAssetCandidate(userID string, projectID string, candidateID string, req ConfirmProjectAssetCandidateRequest) (ProjectAssetSummary, error) {
	return s.projectDomain().ConfirmProjectAssetCandidate(userID, projectID, candidateID, req)
}
