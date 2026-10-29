package app

import (
	"infinite-canvas/backend/internal/model"
)

// resourceQuota and resourceLifecycle are typed adapters so the asset domain
// does not receive Service method values as callbacks.
type resourceQuota struct {
	svc *Service
}

func (q resourceQuota) ReserveUpload(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveUserUploadQuotaFor(userID, size, identity)
}

func (q resourceQuota) ReserveChunked(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveChunkedUploadQuotaFor(userID, size, identity)
}

func (q resourceQuota) ReserveRetry(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveRetryUploadQuotaFor(userID, size, identity)
}

func (q resourceQuota) ReserveGenerated(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveGeneratedResourceQuotaFor(userID, size, identity)
}

func (q resourceQuota) ReserveGeneratedRetry(userID string, size int64, identity string) (string, error) {
	if q.svc == nil {
		return "", nil
	}
	return q.svc.reserveRetryGeneratedQuotaFor(userID, size, identity)
}

func (q resourceQuota) Release(userID string, day string, size int64, identity string) {
	if q.svc == nil {
		return
	}
	q.svc.releaseUserUploadQuotaFor(userID, day, size, identity)
}

func (q resourceQuota) ReleaseRetry(userID string, day string, size int64, identity string) {
	if q.svc == nil {
		return
	}
	q.svc.releaseRetryUploadQuotaFor(userID, day, size, identity)
}

func (q resourceQuota) Commit(userID string, size int64, identity string) {
	if q.svc == nil {
		return
	}
	q.svc.commitUserUploadQuotaFor(userID, size, identity)
}

type resourceLifecycle struct {
	svc *Service
}

func (l resourceLifecycle) RecordActivity(userID string, kind string, count int) {
	if l.svc == nil {
		return
	}
	l.svc.recordActivity(userID, kind, count)
}

func (l resourceLifecycle) AfterResourceReady(resource *model.Resource) {
	if l.svc == nil {
		return
	}
	// Conversion is requested only after the browser cannot decode the original.
}

func (l resourceLifecycle) AppearanceReferencedIDs(resourceIDs []string) map[string]struct{} {
	if l.svc == nil {
		return map[string]struct{}{}
	}
	return l.svc.appearanceReferencedResourceIDs(resourceIDs)
}

func (l resourceLifecycle) RecycleRetentionDays() (int, error) {
	if l.svc == nil {
		return 0, nil
	}
	policy, err := l.svc.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return policy.Resource.RecycleBinRetentionDays, nil
}

func (l resourceLifecycle) WorkerID() string {
	if l.svc == nil {
		return ""
	}
	return l.svc.workerID
}

func (l resourceLifecycle) RunBackground(fn func()) {
	if l.svc == nil || fn == nil {
		return
	}
	l.svc.runWorkerTask(fn)
}

func (l resourceLifecycle) DeleteUserAsset(userID string, assetID string) error {
	if l.svc == nil {
		return nil
	}
	return l.svc.DeleteUserAsset(userID, assetID)
}

func (l resourceLifecycle) WithStorageLock(fn func() error) error {
	if l.svc == nil {
		if fn == nil {
			return nil
		}
		return fn()
	}
	l.svc.storageMu.Lock()
	defer l.svc.storageMu.Unlock()
	return fn()
}
