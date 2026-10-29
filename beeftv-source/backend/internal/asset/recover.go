package asset

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

// RecoveredArtifact is the original provider payload used only when local
// bytes are missing. Callers must not resubmit a model request to build it.
type RecoveredArtifact struct {
	Kind       string
	FileName   string
	MimeType   string
	Size       int64
	Width      int
	Height     int
	DurationMs int64
	Body       io.Reader
}

// ArtifactRestore loads the original provider result. RecoverOwned calls it
// at most once, after the write lock is held and local bytes are known missing.
type ArtifactRestore func() (RecoveredArtifact, error)

// RecoverOwned is the canonical generation-artifact recovery seam. Identity is
// the original taskID:index string; owner is the persisted user. READY+bytes
// replays, PENDING/FAILED+bytes finalizes without restore, and missing bytes
// restore only from the original provider result after kind/MIME/size match
// the stored row. Create and missing-byte retry reserve GeneratedFileMB, not
// ResourceUploadMB. Status transitions stay inside this lock. RecoverOwned
// must not call Store or RetryOwned.
func (s *Service) RecoverOwned(userID, identity string, restore ArtifactRestore) (*model.Resource, error) {
	if s == nil || s.repo == nil {
		return nil, ResourceMissing()
	}
	userID = strings.TrimSpace(userID)
	identity = strings.TrimSpace(identity)
	if userID == "" || identity == "" {
		return nil, fmt.Errorf("generation artifact identity is incomplete")
	}
	uploadKey := NormalizedUploadKey([]string{identity})
	if uploadKey == nil {
		return nil, fmt.Errorf("generation artifact identity is incomplete")
	}
	existing, err := s.resourceForUploadKey(userID, uploadKey)
	if err != nil {
		return nil, err
	}
	resourceID := ""
	if existing != nil {
		resourceID = existing.ID
	}
	unlock := s.lockWrite(userID, uploadKey, resourceID)
	defer unlock()
	existing, err = s.resourceForUploadKey(userID, uploadKey)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return s.recoverExisting(existing, restore)
	}
	return s.recoverCreate(userID, uploadKey, restore)
}

func (s *Service) recoverExisting(resource *model.Resource, restore ArtifactRestore) (*model.Resource, error) {
	if s.objectPresent(resource) {
		if resource.Status == model.ResourceStatusReady {
			return resource, nil
		}
		return s.promoteReady(resource, s.generatedRetryReserve(resource))
	}
	artifact, err := invokeArtifactRestore(restore)
	if err != nil {
		return nil, err
	}
	if err := uploadIdentityConflict(resource, artifact.Kind, artifact.MimeType, artifact.Size); err != nil {
		return nil, err
	}
	incoming := resource.Status
	if incoming == model.ResourceStatusFailed {
		claimed, claimErr := s.repo.ClaimFailedResourceUpload(resource.UserID, resource.ID)
		if claimErr != nil {
			return nil, claimErr
		}
		if !claimed {
			latest, latestErr := s.ownedResource(resource.UserID, resource.ID)
			if latestErr != nil {
				return nil, latestErr
			}
			if latest.Status == model.ResourceStatusReady && s.objectPresent(latest) {
				return latest, nil
			}
			if s.objectPresent(latest) {
				return s.promoteReady(latest, s.generatedRetryReserve(latest))
			}
			return nil, UploadInProgress()
		}
		resource, err = s.ownedResource(resource.UserID, resource.ID)
		if err != nil {
			return nil, err
		}
	} else if incoming != model.ResourceStatusPending && incoming != model.ResourceStatusReady {
		return nil, UploadInProgress()
	}
	return s.recoverWrite(resource, artifact, incoming, false)
}

func (s *Service) recoverCreate(userID string, uploadKey *string, restore ArtifactRestore) (*model.Resource, error) {
	artifact, err := invokeArtifactRestore(restore)
	if err != nil {
		return nil, err
	}
	identity := quotaIdentity(uploadKey, "")
	day, err := s.reserveGenerated(userID, artifact.Size, identity)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	kind := NormalizeKind(artifact.Kind, artifact.MimeType)
	resource := model.Resource{
		ID: kernel.NewID(), UserID: userID, Kind: kind, Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: ObjectKey(userID, kind, artifact.FileName, artifact.MimeType, now),
		MimeType: artifact.MimeType, Size: artifact.Size,
		Width: artifact.Width, Height: artifact.Height, DurationMs: artifact.DurationMs,
		UploadKey: uploadKey, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.repo.CreateResource(&resource); err != nil {
		if existing, lookupErr := s.resourceForUploadKey(userID, uploadKey); lookupErr == nil && existing != nil {
			s.finishQuota(userID, day, artifact.Size, nil, false, err, identity)
			return s.recoverExisting(existing, func() (RecoveredArtifact, error) {
				return artifact, nil
			})
		}
		s.finishQuota(userID, day, artifact.Size, nil, false, err, identity)
		return nil, err
	}
	written, err := s.recoverWrite(&resource, artifact, model.ResourceStatusPending, true)
	s.finishQuota(userID, day, artifact.Size, written, true, err, identity)
	return written, err
}

func (s *Service) recoverWrite(resource *model.Resource, artifact RecoveredArtifact, incoming model.ResourceStatus, alreadyReserved bool) (*model.Resource, error) {
	if resource == nil {
		return nil, ResourceMissing()
	}
	kind := NormalizeKind(artifact.Kind, artifact.MimeType)
	if resource.Provider != "local" {
		resource.Provider = "local"
		resource.Endpoint = ""
		resource.Bucket = ""
		resource.StorageSettingID = ""
		resource.ObjectKey = ObjectKey(resource.UserID, kind, artifact.FileName, artifact.MimeType, time.Now())
	}
	claimedFailed := incoming == model.ResourceStatusFailed
	alreadyConsumed := incoming == model.ResourceStatusReady
	if !alreadyConsumed {
		resource.Status = model.ResourceStatusPending
		resource.Error = ""
	}
	resource.UpdatedAt = time.Now()
	identity := quotaIdentity(resource.UploadKey, resource.ID)
	var day string
	acquired := false
	if !alreadyReserved && !alreadyConsumed {
		var err error
		day, acquired, err = s.ensureReservation(resource.UserID, identity, func() (string, error) {
			return s.reserveGeneratedRetry(resource.UserID, artifact.Size, identity)
		})
		if err != nil {
			if claimedFailed {
				if saveErr := s.persistFailedResource(resource, err); saveErr != nil {
					return resource, errors.Join(err, fmt.Errorf("恢复资源重试失败状态失败：%w", saveErr))
				}
			}
			return resource, err
		}
	}
	etag, err := s.WriteObject(resource, artifact.FileName, artifact.Body)
	resource.UpdatedAt = time.Now()
	if err != nil {
		if alreadyConsumed {
			// Keep durable READY so the next retry does not reserve again.
			return resource, err
		}
		if saveErr := s.persistFailedResource(resource, err); saveErr != nil {
			return resource, errors.Join(err, fmt.Errorf("记录资源失败状态失败：%w", saveErr))
		}
		if acquired {
			s.releaseRetry(resource.UserID, day, artifact.Size, identity)
		}
		return resource, err
	}
	applyRecoveredMetadata(resource, artifact, kind)
	resource.ETag = etag
	if alreadyConsumed {
		_ = s.probeMediaMetadata(context.Background(), resource)
		resource.Status = model.ResourceStatusReady
		resource.Error = ""
		if err := s.repo.SaveResource(resource); err != nil {
			// Leave the original READY row; do not persist PENDING.
			return resource, fmt.Errorf("保存资源就绪状态失败：%w", err)
		}
	} else if err := s.finalizeReady(resource); err != nil {
		return resource, err
	}
	s.commitQuota(resource)
	s.afterReady(resource)
	return resource, nil
}

func (s *Service) generatedRetryReserve(resource *model.Resource) func() (string, error) {
	if resource == nil {
		return nil
	}
	identity := quotaIdentity(resource.UploadKey, resource.ID)
	return func() (string, error) {
		return s.reserveGeneratedRetry(resource.UserID, resource.Size, identity)
	}
}

func (s *Service) promoteReady(resource *model.Resource, reserve func() (string, error)) (*model.Resource, error) {
	if resource == nil {
		return nil, ResourceMissing()
	}
	identity := quotaIdentity(resource.UploadKey, resource.ID)
	if _, _, err := s.ensureReservation(resource.UserID, identity, reserve); err != nil {
		return resource, err
	}
	resource.UpdatedAt = time.Now()
	if err := s.finalizeReady(resource); err != nil {
		return resource, err
	}
	s.commitQuota(resource)
	s.afterReady(resource)
	return resource, nil
}

func applyRecoveredMetadata(resource *model.Resource, artifact RecoveredArtifact, kind string) {
	if resource == nil {
		return
	}
	resource.Kind = kind
	if strings.TrimSpace(artifact.MimeType) != "" {
		resource.MimeType = artifact.MimeType
	}
	resource.Size = artifact.Size
	if artifact.Width > 0 {
		resource.Width = artifact.Width
	}
	if artifact.Height > 0 {
		resource.Height = artifact.Height
	}
	if artifact.DurationMs > 0 {
		resource.DurationMs = artifact.DurationMs
	}
}

func (s *Service) objectPresent(resource *model.Resource) bool {
	if s == nil || s.blobs == nil || resource == nil || strings.TrimSpace(resource.ObjectKey) == "" {
		return false
	}
	return s.blobs.Exists(resource.ObjectKey) == nil
}

func invokeArtifactRestore(restore ArtifactRestore) (RecoveredArtifact, error) {
	if restore == nil {
		return RecoveredArtifact{}, errors.New("generation artifact restore is not initialized")
	}
	artifact, err := restore()
	if err != nil {
		return RecoveredArtifact{}, err
	}
	if artifact.Body == nil {
		return RecoveredArtifact{}, errors.New("local resource body is nil")
	}
	return artifact, nil
}
