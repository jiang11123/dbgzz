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

	"gorm.io/gorm"
)

// Write serialization (Store / RetryOwned / RecoverOwned)
//
// Canonical ownership and locking live here, not on Upload* or delivery
// adapters. Upload calls Store or RetryOwned; generation recovery calls
// RecoverOwned. Callers must not hold a second write lock.
//
// The write lock is process-wide and keyed by the canonical FileStore root
// plus userID plus uploadKey (when present) and resourceID. Two Service
// handles that share a blob root share the lock table. Multiple keys are
// acquired in sorted order so Store(upload) and RetryOwned(upload+id)
// cannot deadlock. Idle keys are dropped when the last owner unlocks.
//
// An in-flight write holds the lock across pending create, byte write, and
// metadata finalize. A concurrent Store on any handle waits, then returns
// the persisted READY row or UploadInProgress for leftover FAILED/PENDING.
// A concurrent RetryOwned or RecoverOwned waits, then returns READY or
// continues the leftover row. An active write is never overwritten by a
// second handle.
//
// Leftover PENDING is reclaimed only when no live owner holds the lock
// (process restart or the writer finished). A fresh Service is not treated as
// restart while another handle is still writing. Store does not reclaim
// non-READY rows. Generation adapters should call RecoverOwned so READY
// rows with missing bytes can restore from the original provider result.
//
// Quota: callers of Store reserve upload/chunked quota under this operation's
// identity. PENDING means that reservation is still held (including after a
// crash that never ran Release). FAILED means a positive witness was released;
// an unattributed Size-0 marker stays until the unfinished row is deleted.
// READY means daily usage is consumed and a positive witness is cleared.
// SaveResource applies that reservation mutation in the same transaction as
// the terminal status so a crash cannot leave a unique witness behind a READY
// or FAILED row. Local bytes are independent of that reservation: a READY-save
// failure keeps PENDING and the reservation; a write failure records FAILED
// and Releases a positive hold. PENDING about to become READY must hold a
// witness; if missing, reserve now. An unattributed leftover marker must not
// reserve.
// ClaimFailed is status-only so leftover FAILED can keep the original consume.
// RecoverOwned uses ReserveGenerated / ReserveGeneratedRetry the same way.
// Commit applies only to this identity's pending.
//
// Ordinary Upload* adapters must not take lockWrite. The lock lives here so
// Store and RetryOwned cannot deadlock. A live duplicate identity is rejected
// by the reservation unique index before Store and mapped to UploadInProgress.

// Store creates a pending row, publishes bytes through FileStore, then marks
// READY. A failed READY save leaves PENDING with bytes on disk so the same
// identity can recover without a second daily reserve. READY is never
// recorded without a successful metadata save after a successful file write.
func (s *Service) Store(userID string, kind string, fileName string, mimeType string, size int64, width int, height int, durationMs int64, body io.Reader, uploadKey *string) (*model.Resource, bool, error) {
	if s == nil || s.repo == nil {
		return nil, false, ResourceMissing()
	}
	unlock := s.lockWrite(userID, uploadKey, "")
	defer unlock()
	if existing, err := s.resourceForUploadKey(userID, uploadKey); err != nil {
		return nil, false, err
	} else if existing != nil {
		if existing.Status == model.ResourceStatusReady {
			return existing, false, nil
		}
		return nil, false, UploadInProgress()
	}
	now := time.Now()
	kind = NormalizeKind(kind, mimeType)
	objectKey := ObjectKey(userID, kind, fileName, mimeType, now)
	resource := model.Resource{
		ID: kernel.NewID(), UserID: userID, Kind: kind, Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: objectKey, MimeType: mimeType, Size: size,
		Width: width, Height: height, DurationMs: durationMs, UploadKey: uploadKey,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.repo.CreateResource(&resource); err != nil {
		if existing, lookupErr := s.resourceForUploadKey(userID, uploadKey); lookupErr == nil && existing != nil {
			if existing.Status == model.ResourceStatusReady {
				return existing, false, nil
			}
			return nil, false, UploadInProgress()
		}
		return nil, false, err
	}
	etag, err := s.WriteObject(&resource, fileName, body)
	resource.UpdatedAt = time.Now()
	if err != nil {
		if saveErr := s.persistFailedResource(&resource, err); saveErr != nil {
			return &resource, true, errors.Join(err, fmt.Errorf("记录资源失败状态失败：%w", saveErr))
		}
		return &resource, true, err
	}
	resource.ETag = etag
	if err := s.finalizeReady(&resource); err != nil {
		return &resource, true, err
	}
	s.afterReady(&resource)
	return &resource, true, nil
}

func (s *Service) finalizeReady(resource *model.Resource) error {
	if resource == nil {
		return ResourceMissing()
	}
	// Preserve generated bytes even if probing is unavailable. References with
	// missing facts must pass EnsureMediaMetadata before any upstream request.
	_ = s.probeMediaMetadata(context.Background(), resource)
	resource.Status = model.ResourceStatusReady
	resource.Error = ""
	if err := s.repo.SaveResource(resource); err != nil {
		resource.Status = model.ResourceStatusPending
		resource.Error = fmt.Sprintf("保存资源就绪状态失败：%v", err)
		if statusErr := s.repo.SaveResource(resource); statusErr != nil {
			return errors.Join(err, fmt.Errorf("记录资源失败状态失败：%w", statusErr))
		}
		return fmt.Errorf("保存资源就绪状态失败：%w", err)
	}
	return nil
}

func (s *Service) WriteObject(resource *model.Resource, fileName string, body io.Reader) (string, error) {
	if resource == nil {
		return "", errors.New("资源不存在")
	}
	if s == nil || s.blobs == nil {
		return "", errors.New("local resource store is not initialized")
	}
	resource.Provider = "local"
	resource.Endpoint = ""
	resource.Bucket = ""
	resource.StorageSettingID = ""
	resource.ETag = ""
	if strings.TrimSpace(resource.ObjectKey) == "" {
		resource.ObjectKey = ObjectKey(resource.UserID, resource.Kind, fileName, resource.MimeType, time.Now())
	}
	return "", s.blobs.Write(resource.ObjectKey, body)
}

// Retry completes a FAILED or leftover PENDING upload under the same identity.
// The caller-supplied Resource is used only for its ID; owner, status, object
// key, and metadata are taken from the persisted row.
func (s *Service) Retry(userID string, resource *model.Resource, kind string, mimeType string, size int64, body io.Reader) (*model.Resource, error) {
	if resource == nil {
		return nil, ResourceMissing()
	}
	return s.RetryOwned(userID, resource.ID, kind, mimeType, size, body)
}

// RetryOwned is the canonical retry seam for upload replay and generation
// adapters. It loads ResourceForUser before any return or write.
func (s *Service) RetryOwned(userID string, resourceID string, kind string, mimeType string, size int64, body io.Reader) (*model.Resource, error) {
	if s == nil || s.repo == nil {
		return nil, ResourceMissing()
	}
	resource, err := s.ownedResource(userID, resourceID)
	if err != nil {
		return nil, err
	}
	if resource.Status == model.ResourceStatusReady {
		return resource, nil
	}
	if err := uploadIdentityConflict(resource, kind, mimeType, size); err != nil {
		return nil, err
	}
	unlock := s.lockWrite(userID, resource.UploadKey, resource.ID)
	defer unlock()
	resource, err = s.ownedResource(userID, resourceID)
	if err != nil {
		return nil, err
	}
	if resource.Status == model.ResourceStatusReady {
		return resource, nil
	}
	if err := uploadIdentityConflict(resource, kind, mimeType, size); err != nil {
		return nil, err
	}
	released := resource.Status == model.ResourceStatusFailed
	if released {
		claimed, claimErr := s.repo.ClaimFailedResourceUpload(userID, resource.ID)
		if claimErr != nil {
			return nil, claimErr
		}
		if !claimed {
			latest, latestErr := s.ownedResource(userID, resourceID)
			if latestErr != nil {
				return nil, latestErr
			}
			if latest.Status == model.ResourceStatusReady {
				return latest, nil
			}
			return nil, UploadInProgress()
		}
		resource, err = s.ownedResource(userID, resourceID)
		if err != nil {
			return nil, err
		}
	} else if resource.Status != model.ResourceStatusPending {
		return nil, UploadInProgress()
	}
	kind = NormalizeKind(kind, mimeType)
	if resource.Provider != "local" {
		resource.Provider = "local"
		resource.Endpoint = ""
		resource.Bucket = ""
		resource.StorageSettingID = ""
		resource.ObjectKey = ObjectKey(userID, kind, "", mimeType, time.Now())
	}
	resource.Status = model.ResourceStatusPending
	resource.Error = ""
	resource.UpdatedAt = time.Now()
	identity := quotaIdentity(resource.UploadKey, resource.ID)
	day, heldRetry, err := s.ensureReservation(userID, identity, func() (string, error) {
		return s.reserveRetry(userID, size, identity)
	})
	if err != nil {
		if released {
			if saveErr := s.persistFailedResource(resource, err); saveErr != nil {
				return nil, errors.Join(err, fmt.Errorf("恢复资源重试失败状态失败：%w", saveErr))
			}
		}
		return nil, err
	}
	etag, err := s.WriteObject(resource, "", body)
	resource.UpdatedAt = time.Now()
	if err != nil {
		if saveErr := s.persistFailedResource(resource, err); saveErr != nil {
			return nil, errors.Join(err, fmt.Errorf("记录资源重试失败状态失败：%w", saveErr))
		}
		if heldRetry {
			s.releaseRetry(userID, day, size, identity)
		}
		return nil, err
	}
	resource.ETag = etag
	if err := s.finalizeReady(resource); err != nil {
		return nil, err
	}
	s.commitQuota(resource)
	s.afterReady(resource)
	return resource, nil
}

func (s *Service) ownedResource(userID string, resourceID string) (*model.Resource, error) {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(resourceID) == "" {
		return nil, ResourceMissing()
	}
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ResourceMissing()
		}
		return nil, err
	}
	if resource == nil {
		return nil, ResourceMissing()
	}
	return resource, nil
}

func uploadIdentityConflict(resource *model.Resource, kind string, mimeType string, size int64) error {
	if resource == nil {
		return ResourceMissing()
	}
	kind = NormalizeKind(kind, mimeType)
	if resource.Size != size || resource.Kind != kind || (resource.MimeType != "" && mimeType != "" && resource.MimeType != mimeType) {
		return UploadConflict()
	}
	return nil
}

func (s *Service) reserveRetry(userID string, size int64, identity string) (string, error) {
	if s == nil || s.quota == nil {
		return "", nil
	}
	return mapQuotaReserveError(s.quota.ReserveRetry(userID, size, identity))
}

func (s *Service) releaseRetry(userID string, day string, size int64, identity string) {
	if s == nil || s.quota == nil {
		return
	}
	s.quota.ReleaseRetry(userID, day, size, identity)
}

func (s *Service) ensureReservation(userID, identity string, reserve func() (string, error)) (string, bool, error) {
	row, err := s.lookupReservation(userID, identity)
	if err != nil {
		return "", false, err
	}
	if row != nil {
		if row.Unattributed() {
			return "", false, UploadQuotaAttributionUncertain()
		}
		return "", false, nil
	}
	if reserve == nil {
		return "", false, nil
	}
	day, err := reserve()
	if err != nil {
		return "", false, err
	}
	return day, true, nil
}

func (s *Service) persistFailedResource(resource *model.Resource, cause error) error {
	if resource == nil {
		return nil
	}
	resource.Status = model.ResourceStatusFailed
	if cause != nil {
		resource.Error = cause.Error()
	}
	resource.UpdatedAt = time.Now()
	if saveErr := s.repo.SaveResource(resource); saveErr != nil {
		resource.Status = model.ResourceStatusPending
		return saveErr
	}
	return nil
}
