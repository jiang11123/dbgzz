package asset

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

type ResourceUsage struct {
	Kind  string
	ID    string
	Title string
}

func OccupiedMessage(usages []ResourceUsage) string {
	seen := map[string]struct{}{}
	labels := make([]string, 0, len(usages))
	for _, usage := range usages {
		key := usage.Kind + "\x00" + usage.ID
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		title := strings.TrimSpace(usage.Title)
		if title == "" {
			title = usage.ID
		}
		title = kernel.TruncateRunes(title, 32)
		labels = append(labels, usage.Kind+"「"+title+"」")
	}
	if len(labels) == 0 {
		return ""
	}
	sort.Strings(labels)
	visible := labels
	if len(visible) > 3 {
		visible = append(append([]string{}, visible[:3]...), fmt.Sprintf("等 %d 处", len(labels)))
	}
	return "素材仍被" + strings.Join(visible, "、") + "引用，请先在对应画布、任务或业务记录中解除引用后再删除"
}

func StorageIdentity(resource *model.Resource) string {
	if resource == nil {
		return ""
	}
	provider := strings.ToLower(strings.TrimSpace(resource.Provider))
	if provider == "" {
		provider = "local"
	}
	return strings.Join([]string{provider, resource.Endpoint, resource.Bucket, resource.ObjectKey}, "\x00")
}

func DeletionJobs(userID string, physicalObjects map[string]*model.Resource) []model.ResourceDeletionJob {
	keys := make([]string, 0, len(physicalObjects))
	for key := range physicalObjects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	now := time.Now()
	jobs := make([]model.ResourceDeletionJob, 0, len(keys))
	for _, key := range keys {
		resource := physicalObjects[key]
		jobs = append(jobs, model.ResourceDeletionJob{
			ID: kernel.NewID(), UserID: userID, ResourceID: resource.ID,
			Provider: resource.Provider, Endpoint: resource.Endpoint, Bucket: resource.Bucket,
			StorageSettingID: resource.StorageSettingID, ObjectKey: resource.ObjectKey,
			Status: model.ResourceDeletionStatusPending, NextAttemptAt: now,
		})
	}
	return jobs
}

func normalizeExpectedAssetStatus(values []string) (string, error) {
	if len(values) == 0 {
		return "", nil
	}
	value := strings.TrimSpace(values[0])
	if value == "" {
		return "", nil
	}
	if value != string(model.AssetVersionStatusArchived) {
		return "", kernel.BadAuthRequest("删除条件无效")
	}
	return value, nil
}

func (s *Service) DeleteUserAssetWithResources(userID string, assetID string, expectedStatus ...string) error {
	if s == nil || s.repo == nil {
		return ResourceMissing()
	}
	expected, err := normalizeExpectedAssetStatus(expectedStatus)
	if err != nil {
		return err
	}
	asset, err := s.repo.AssetForUser(userID, assetID)
	if err != nil {
		return err
	}
	if expected != "" && string(asset.Status) != expected {
		return TrashStatusConflict()
	}
	assetReferences, err := s.repo.AssetBusinessReferences(userID, assetID)
	if err != nil {
		return err
	}
	versions, representations, err := s.repo.AssetResourceRecords(assetID)
	if err != nil {
		return err
	}

	resourceIDs := map[string]struct{}{}
	if err := assets.CollectOwnedDocumentReferences(asset.PayloadJSON, resourceIDs); err != nil {
		return UnreadableAssetDocument("asset")
	}
	for _, version := range versions {
		if err := assets.CollectOwnedDocumentReferences(version.DefinitionJSON, resourceIDs); err != nil {
			return UnreadableAssetDocument("version")
		}
	}
	for _, representation := range representations {
		if resourceID := assets.ValidID(representation.ResourceID); resourceID != "" {
			resourceIDs[resourceID] = struct{}{}
		}
		if err := assets.CollectOwnedDocumentReferences(representation.MetadataJSON, resourceIDs); err != nil {
			return UnreadableAssetDocument("representation")
		}
	}

	candidateIDs := assets.SortedIDs(resourceIDs)
	resources, err := s.repo.ResourcesForUserIDs(userID, candidateIDs)
	if err != nil {
		return err
	}
	ownedIDs := make([]string, 0, len(resources))
	ownedIDSet := make(map[string]struct{}, len(resources))
	for _, resource := range resources {
		ownedIDs = append(ownedIDs, resource.ID)
		ownedIDSet[resource.ID] = struct{}{}
	}

	usages := make([]ResourceUsage, 0, len(assetReferences))
	for _, reference := range assetReferences {
		usages = append(usages, ResourceUsage{Kind: reference.Kind, ID: reference.ID, Title: reference.Title})
	}
	if len(ownedIDs) > 0 {
		snapshot, snapshotErr := s.repo.ResourceReferenceSnapshot(userID, assetID, ownedIDs)
		if snapshotErr != nil {
			return snapshotErr
		}
		retainedResourceIDs := map[string]struct{}{}
		for _, reference := range snapshot.Direct {
			if _, exists := ownedIDSet[reference.ResourceID]; exists {
				retainedResourceIDs[reference.ResourceID] = struct{}{}
			}
		}
		for _, document := range snapshot.Documents {
			switch document.TaskStatus {
			case model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled:
				if document.Kind == "任务日志" || document.Kind == "任务结果" {
					continue
				}
				if document.Kind == "任务" {
					document.SecondaryJSON = ""
				}
			}
			referencedIDs := assets.DocumentReferencedIDs(document.PrimaryJSON, ownedIDSet)
			for resourceID := range assets.DocumentReferencedIDs(document.SecondaryJSON, ownedIDSet) {
				referencedIDs[resourceID] = struct{}{}
			}
			if len(referencedIDs) > 0 {
				for resourceID := range referencedIDs {
					retainedResourceIDs[resourceID] = struct{}{}
				}
			}
		}
		if len(retainedResourceIDs) > 0 {
			deletableOwnedIDs := ownedIDs[:0]
			for _, resourceID := range ownedIDs {
				if _, retained := retainedResourceIDs[resourceID]; !retained {
					deletableOwnedIDs = append(deletableOwnedIDs, resourceID)
				}
			}
			ownedIDs = deletableOwnedIDs
		}
	}
	if message := OccupiedMessage(usages); message != "" {
		return kernel.BadAuthRequest(message)
	}

	physicalObjects := map[string]*model.Resource{}
	for index := range resources {
		resource := &resources[index]
		sharedCount, countErr := s.repo.ResourceStorageReferenceCount(resource, ownedIDs)
		if countErr != nil {
			return countErr
		}
		if sharedCount > 0 {
			continue
		}
		physicalObjects[StorageIdentity(resource)] = resource
	}
	deletionJobs := DeletionJobs(userID, physicalObjects)
	if err := s.repo.DeleteAssetAndResources(userID, assetID, ownedIDs, deletionJobs, expected); err != nil {
		if errors.Is(err, repository.ErrCanvasHistoryResourceReferenced) || errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
			// A reference appeared after the snapshot. Keep every resource and
			// remove only the asset record in a fresh guarded transaction.
			if retryErr := s.repo.DeleteAssetAndResources(userID, assetID, nil, nil, expected); retryErr == nil {
				return nil
			} else {
				err = retryErr
			}
		}
		if errors.Is(err, repository.ErrAssetExpectedStatusMismatch) {
			return TrashStatusConflict()
		}
		return fmt.Errorf("素材记录删除失败，请重试：%w", err)
	}
	if len(deletionJobs) > 0 {
		s.runBackground(func() { s.DrainDeletionJobs(len(deletionJobs)) })
	}
	return nil
}

func (s *Service) DeleteStoredObject(userID string, resource *model.Resource) error {
	if resource == nil {
		return errors.New("资源记录为空")
	}
	if s == nil || s.repo == nil {
		return ResourceMissing()
	}
	persisted, err := s.repo.ResourceForUser(userID, resource.ID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ResourceMissing()
		}
		return err
	}
	return s.deleteTrustedObject(userID, persisted)
}

func (s *Service) deleteOutboxObject(job *model.ResourceDeletionJob) error {
	if job == nil || strings.TrimSpace(job.UserID) == "" || strings.TrimSpace(job.ObjectKey) == "" {
		return errors.New("资源记录为空")
	}
	return s.deleteTrustedObject(job.UserID, &model.Resource{
		ID: job.ResourceID, UserID: job.UserID, Provider: job.Provider,
		Endpoint: job.Endpoint, Bucket: job.Bucket, StorageSettingID: job.StorageSettingID,
		ObjectKey: job.ObjectKey,
	})
}

func (s *Service) deleteTrustedObject(userID string, resource *model.Resource) error {
	if resource == nil {
		return errors.New("资源记录为空")
	}
	if strings.TrimSpace(userID) == "" || (resource.UserID != "" && resource.UserID != userID) {
		return ResourceMissing()
	}
	if strings.TrimSpace(resource.ObjectKey) == "" {
		return fmt.Errorf("资源 %s 的存储路径为空", resource.ID)
	}
	if s == nil || s.repo == nil {
		return ResourceMissing()
	}
	protected, err := s.repo.CanvasHistoryReferencesObject(resource)
	if err != nil {
		return err
	}
	if protected {
		return errors.New("资源仍被画布历史版本引用")
	}
	provider := strings.ToLower(strings.TrimSpace(resource.Provider))
	if s.localStorage && provider != "" && provider != "local" {
		return nil
	}
	switch provider {
	case "", "local":
		return s.DeleteLocalObject(resource.ObjectKey)
	default:
		return nil
	}
}

func (s *Service) DeleteLocalObject(objectKey string) error {
	if s == nil || s.blobs == nil {
		return errors.New("local resource store is not initialized")
	}
	if err := s.blobs.Delete(objectKey); err != nil {
		return fmt.Errorf("删除本地资源文件失败：%w", err)
	}
	return nil
}
