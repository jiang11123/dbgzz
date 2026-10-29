package app

import (
	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
)

type CreateAssetFolderRequest = asset.CreateAssetFolderRequest
type UpdateAssetFolderRequest = asset.UpdateAssetFolderRequest
type MoveUserAssetsRequest = asset.MoveUserAssetsRequest

func (s *Service) assetLibrary() *asset.Library {
	return s.canvasDomain().Library()
}

func (s *Service) AssetFolders(userID string) ([]model.AssetFolder, error) {
	return s.assetLibrary().AssetFolders(userID)
}

func (s *Service) CreateAssetFolder(userID string, req CreateAssetFolderRequest) (model.AssetFolder, error) {
	return s.assetLibrary().CreateAssetFolder(userID, req)
}

func (s *Service) UpdateAssetFolder(userID string, folderID string, req UpdateAssetFolderRequest) (model.AssetFolder, error) {
	return s.assetLibrary().UpdateAssetFolder(userID, folderID, req)
}

func (s *Service) DeleteAssetFolder(userID string, folderID string) error {
	return s.assetLibrary().DeleteAssetFolder(userID, folderID)
}

func (s *Service) MoveUserAssetsToFolder(userID string, req MoveUserAssetsRequest) error {
	return s.assetLibrary().MoveUserAssetsToFolder(userID, req)
}
