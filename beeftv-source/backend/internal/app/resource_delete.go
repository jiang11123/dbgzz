package app

import (
	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) deleteUserAssetWithResources(userID string, assetID string, expectedStatus ...string) error {
	return s.resourceDomain().DeleteUserAssetWithResources(userID, assetID, expectedStatus...)
}

func resourceDeletionJobs(userID string, physicalObjects map[string]*model.Resource) []model.ResourceDeletionJob {
	return localasset.DeletionJobs(userID, physicalObjects)
}

type resourceUsage = localasset.ResourceUsage

func resourceOccupiedMessage(usages []resourceUsage) string {
	return localasset.OccupiedMessage(usages)
}

func collectOwnedAssetDocumentReferences(raw string, resourceIDs map[string]struct{}) error {
	return assets.CollectOwnedDocumentReferences(raw, resourceIDs)
}

func documentReferencesResources(raw string, resourceIDs map[string]struct{}) bool {
	return assets.DocumentReferences(raw, resourceIDs)
}

func documentReferencedResourceIDs(raw string, resourceIDs map[string]struct{}) map[string]struct{} {
	return assets.DocumentReferencedIDs(raw, resourceIDs)
}

func sortedReferenceIDs(values map[string]struct{}) []string {
	return assets.SortedIDs(values)
}

func resourceStorageIdentity(resource *model.Resource) string {
	return localasset.StorageIdentity(resource)
}

func (s *Service) deleteStoredResourceObject(userID string, resource *model.Resource) error {
	return s.resourceDomain().DeleteStoredObject(userID, resource)
}

func (s *Service) deleteLocalResourceObject(objectKey string) error {
	return s.resourceDomain().DeleteLocalObject(objectKey)
}
