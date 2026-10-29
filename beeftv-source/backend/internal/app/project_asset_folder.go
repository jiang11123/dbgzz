package app

import (
	"infinite-canvas/backend/internal/model"
	localproject "infinite-canvas/backend/internal/project"
)

type CreateProjectAssetFolderRequest = localproject.CreateProjectAssetFolderRequest
type UpdateProjectAssetFolderRequest = localproject.UpdateProjectAssetFolderRequest

func (s *Service) ProjectAssetFolders(userID string, projectID string) ([]model.ProjectAssetFolder, error) {
	return s.projectDomain().ProjectAssetFolders(userID, projectID)
}

func (s *Service) CreateProjectAssetFolder(userID string, projectID string, req CreateProjectAssetFolderRequest) (model.ProjectAssetFolder, error) {
	return s.projectDomain().CreateProjectAssetFolder(userID, projectID, req)
}

func (s *Service) UpdateProjectAssetFolder(userID string, projectID string, folderID string, req UpdateProjectAssetFolderRequest) (model.ProjectAssetFolder, error) {
	return s.projectDomain().UpdateProjectAssetFolder(userID, projectID, folderID, req)
}

func (s *Service) DeleteProjectAssetFolder(userID string, projectID string, folderID string) error {
	return s.projectDomain().DeleteProjectAssetFolder(userID, projectID, folderID)
}

func validateProjectAssetFolderParent(folders []model.ProjectAssetFolder, folderID string, parentID string) error {
	return localproject.ValidateAssetFolderParent(folders, folderID, parentID)
}

func projectAssetFolderNameExists(folders []model.ProjectAssetFolder, parentID string, name string, excludeID string) bool {
	return localproject.AssetFolderNameExists(folders, parentID, name, excludeID)
}

func validateProjectAssetFolderTheme(value string) (string, error) {
	return localproject.ValidateAssetFolderTheme(value)
}
