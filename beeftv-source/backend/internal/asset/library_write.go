package asset

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func (l *Library) UpsertUserAsset(userID string, raw json.RawMessage) (Summary, error) {
	if err := l.requireHost(); err != nil {
		return Summary{}, err
	}
	item, err := AssetFromJSON(userID, raw)
	if err != nil {
		return Summary{}, err
	}
	err = l.host.WithStorageLock(func() error {
		created, err := l.PrepareAssetWrites(userID, []model.Asset{item})
		if err != nil {
			return err
		}
		if err := l.repo.Transaction(func(tx *repository.Repository) error {
			return l.WithRepository(tx).persistPreparedAsset(userID, &item)
		}); err != nil {
			return err
		}
		if created > 0 {
			l.host.RecordActivity(userID, "asset", created)
		}
		return nil
	})
	if err != nil {
		return Summary{}, err
	}
	return summaryFromAsset(item), nil
}

func (l *Library) DeleteUserAsset(userID string, id string, expectedStatus ...string) error {
	if err := l.requireHost(); err != nil {
		return err
	}
	return l.host.WithStorageLock(func() error {
		return l.host.DeleteUserAssetWithResources(userID, id, expectedStatus...)
	})
}

func (l *Library) ReplaceUserAssets(userID string, req AssetsSyncRequest) ([]json.RawMessage, error) {
	if err := l.requireHost(); err != nil {
		return nil, err
	}
	items := make([]model.Asset, 0, len(req.Assets))
	var totalBytes int64
	for _, raw := range req.Assets {
		item, err := AssetFromJSON(userID, raw)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
		totalBytes += int64(len(raw))
	}
	if _, err := uniquePreparedAssets(items); err != nil {
		return nil, err
	}
	err := l.host.WithStorageLock(func() error {
		if err := l.GuardReplacementCanvasReferences(userID, items); err != nil {
			return err
		}
		if err := l.host.StructuredReplacementQuota(userID, "asset", len(items), totalBytes); err != nil {
			return err
		}
		if err := l.repo.Transaction(func(tx *repository.Repository) error {
			scoped := l.WithRepository(tx)
			if err := scoped.GuardReplacementCanvasReferences(userID, items); err != nil {
				return err
			}
			for index := range items {
				if err := scoped.validateOwnedResources(userID, items[index].PayloadJSON); err != nil {
					return err
				}
				if err := scoped.requireOwnedFolder(userID, items[index].FolderID); err != nil {
					return err
				}
			}
			return tx.ReplaceAssets(userID, items)
		}); err != nil {
			return err
		}
		if len(items) > 0 {
			l.host.RecordActivity(userID, "asset", len(items))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return l.UserAssets(userID)
}

// PrepareAssetWrites validates folder ownership, resource ownership and canvas
// reference guards, then checks aggregate quota once. Quota is check-only.
// Callers must already hold the storage lock. PersistPreparedAssets still has
// to run inside the caller's transaction.
func (l *Library) PrepareAssetWrites(userID string, items []model.Asset) (int, error) {
	if err := l.requireHost(); err != nil {
		return 0, err
	}
	items, err := uniquePreparedAssets(items)
	if err != nil {
		return 0, err
	}
	created := 0
	var deltaBytes int64
	for index := range items {
		item := items[index]
		existingBytes, creating, err := l.prepareOwnedAssetWrite(userID, item)
		if err != nil {
			return 0, err
		}
		deltaBytes += int64(len([]byte(item.PayloadJSON))) - existingBytes
		if creating {
			created++
		}
	}
	if err := l.host.StructuredBatchQuota(userID, "asset", created, deltaBytes); err != nil {
		return 0, err
	}
	return created, nil
}

// PersistPreparedAssets writes already-parsed assets through the bound
// repository without opening a nested transaction or taking the storage lock.
// Canvas generated commits must call this on Library.WithRepository(tx) after
// PrepareAssetWrites so folder, resource and canvas-reference checks share
// that transaction.
func (l *Library) PersistPreparedAssets(userID string, items []model.Asset) (int, error) {
	if err := l.requireHost(); err != nil {
		return 0, err
	}
	items, err := uniquePreparedAssets(items)
	if err != nil {
		return 0, err
	}
	created := 0
	for index := range items {
		item := &items[index]
		_, existingErr := l.repo.AssetForUser(userID, item.ID)
		if existingErr != nil && !isNotFound(existingErr) {
			return 0, existingErr
		}
		if err := l.persistPreparedAsset(userID, item); err != nil {
			return 0, err
		}
		if isNotFound(existingErr) {
			created++
		}
	}
	return created, nil
}

func uniquePreparedAssets(items []model.Asset) ([]model.Asset, error) {
	seen := make(map[string]struct{}, len(items))
	for index := range items {
		id := strings.TrimSpace(items[index].ID)
		if id == "" {
			return nil, kernel.BadAuthRequest("素材 ID 无效")
		}
		if _, exists := seen[id]; exists {
			return nil, kernel.BadAuthRequest("素材列表包含重复 ID")
		}
		seen[id] = struct{}{}
	}
	return items, nil
}

func (l *Library) prepareOwnedAssetWrite(userID string, item model.Asset) (existingBytes int64, creating bool, err error) {
	if err := l.requireOwnedFolder(userID, item.FolderID); err != nil {
		return 0, false, err
	}
	existing, existingErr := l.repo.AssetForUser(userID, item.ID)
	if existingErr != nil && !isNotFound(existingErr) {
		return 0, false, existingErr
	}
	creating = isNotFound(existingErr)
	if existing != nil && existing.PayloadJSON != item.PayloadJSON {
		if err := l.GuardCanvasReferences(userID, item); err != nil {
			return 0, false, err
		}
	}
	if err := l.validateOwnedResources(userID, item.PayloadJSON); err != nil {
		return 0, false, err
	}
	if existing != nil {
		existingBytes = int64(len([]byte(existing.PayloadJSON)))
	}
	return existingBytes, creating, nil
}

func (l *Library) persistPreparedAsset(userID string, item *model.Asset) error {
	if err := l.requireOwnedFolder(userID, item.FolderID); err != nil {
		return err
	}
	if err := l.validateOwnedResources(userID, item.PayloadJSON); err != nil {
		return err
	}
	existing, existingErr := l.repo.AssetForUser(userID, item.ID)
	if existingErr != nil && !isNotFound(existingErr) {
		return existingErr
	}
	if existing != nil && existing.PayloadJSON != item.PayloadJSON {
		if err := l.GuardCanvasReferences(userID, *item); err != nil {
			return err
		}
	}
	return l.repo.UpsertAsset(item)
}

func (l *Library) requireOwnedFolder(userID, folderID string) error {
	if folderID == "" {
		return nil
	}
	if _, err := l.repo.AssetFolderForUser(userID, folderID); err != nil {
		if isNotFound(err) {
			return kernel.BadAuthRequest("素材分类不存在")
		}
		return err
	}
	return nil
}

func (l *Library) validateOwnedResources(userID, payloadJSON string) error {
	ids := map[string]struct{}{}
	if err := assets.CollectOwnedDocumentReferences(payloadJSON, ids); err != nil {
		return kernel.BadAuthRequest("素材数据无法解析")
	}
	if len(ids) == 0 {
		return nil
	}
	wanted := assets.SortedIDs(ids)
	resources, err := l.repo.ResourcesForUserIDs(userID, wanted)
	if err != nil {
		return err
	}
	owned := make(map[string]model.Resource, len(resources))
	for _, resource := range resources {
		owned[resource.ID] = resource
	}
	for _, id := range wanted {
		resource, exists := owned[id]
		if !exists {
			return kernel.BadAuthRequest("素材引用的资源不存在或不属于当前用户")
		}
		if resource.Status != model.ResourceStatusReady {
			return kernel.BadAuthRequest("素材引用的资源尚未就绪")
		}
	}
	return nil
}
