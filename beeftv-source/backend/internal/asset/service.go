package asset

import (
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"sort"
	"strings"
	"sync"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

type countedWriteLock struct {
	mu   sync.Mutex
	refs int
}

type writeLockRegistry struct {
	mu    sync.Mutex
	locks map[string]*countedWriteLock
}

var workspaceWriteLocks writeLockRegistry

func (r *writeLockRegistry) acquire(keys []string) func() {
	if len(keys) == 0 {
		return func() {}
	}
	sort.Strings(keys)
	type held struct {
		key  string
		lock *countedWriteLock
	}
	heldLocks := make([]held, 0, len(keys))
	r.mu.Lock()
	if r.locks == nil {
		r.locks = map[string]*countedWriteLock{}
	}
	for _, key := range keys {
		lock := r.locks[key]
		if lock == nil {
			lock = &countedWriteLock{}
			r.locks[key] = lock
		}
		lock.refs++
		heldLocks = append(heldLocks, held{key: key, lock: lock})
	}
	r.mu.Unlock()
	for _, item := range heldLocks {
		item.lock.mu.Lock()
	}
	return func() {
		for index := len(heldLocks) - 1; index >= 0; index-- {
			heldLocks[index].lock.mu.Unlock()
		}
		r.mu.Lock()
		for _, item := range heldLocks {
			item.lock.refs--
			if item.lock.refs == 0 {
				delete(r.locks, item.key)
			}
		}
		r.mu.Unlock()
	}
}

func (r *writeLockRegistry) len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.locks)
}

type ResourceStream = assets.ResourceStream
type ResourceDeliveryOptions = assets.ResourceDeliveryOptions
type ResourceDelivery = assets.ResourceDelivery

// Service owns durable local resource rules.
type Service struct {
	repo         Repository
	blobs        BlobStore
	quota        Quota
	lifecycle    Lifecycle
	localStorage bool
	dataDir      string
	sessionMu    sync.Mutex
	sessions     map[string]*chunkedUploadSession
}

func NewService(deps Dependencies) *Service {
	svc := &Service{
		repo:         deps.Repository,
		blobs:        deps.Blobs,
		quota:        deps.Quota,
		lifecycle:    deps.Lifecycle,
		localStorage: deps.LocalStorage,
		dataDir:      strings.TrimSpace(deps.DataDir),
		sessions:     map[string]*chunkedUploadSession{},
	}
	if svc.dataDir != "" {
		svc.abandonStaleSessions()
	}
	return svc
}

func (s *Service) writeSpace() string {
	if s != nil {
		if store, ok := s.blobs.(*FileStore); ok && store != nil {
			if root := strings.TrimSpace(store.writeSpace()); root != "" {
				return root
			}
		}
	}
	return fmt.Sprintf("service:%p", s)
}

// lockWrite serializes Store/RetryOwned/RecoverOwned for every Service that
// shares the same canonical FileStore root. Keys include the user so identical
// client upload keys cannot cross owners. Multiple keys are taken in sorted
// order to avoid nested deadlock. Entries are released when the last owner
// unlocks so the table cannot grow without bound. A second handle cannot
// reclaim an in-flight PENDING write; leftover PENDING is reclaimable only
// when no live owner holds the lock.
func (s *Service) lockWrite(userID string, uploadKey *string, resourceID string) func() {
	if s == nil {
		return func() {}
	}
	userID = strings.TrimSpace(userID)
	resourceID = strings.TrimSpace(resourceID)
	space := s.writeSpace()
	keys := make([]string, 0, 2)
	if userID != "" && uploadKey != nil {
		if key := strings.TrimSpace(*uploadKey); key != "" {
			keys = append(keys, space+"\x00upload\x00"+userID+"\x00"+key)
		}
	}
	if userID != "" && resourceID != "" {
		keys = append(keys, space+"\x00resource\x00"+userID+"\x00"+resourceID)
	}
	return workspaceWriteLocks.acquire(keys)
}

func (s *Service) Resources(userID string, limit int) ([]model.Resource, error) {
	if s == nil || s.repo == nil {
		return nil, ResourceMissing()
	}
	resources, err := s.repo.Resources(userID, limit)
	if err != nil {
		return nil, err
	}
	for index := range resources {
		resources[index].PublicURL = ""
		if err := s.validateListedResource(&resources[index]); err != nil {
			return nil, err
		}
	}
	return resources, nil
}

func (s *Service) Resource(userID string, id string) (*model.Resource, error) {
	if s == nil || s.repo == nil {
		return nil, ResourceMissing()
	}
	resource, err := s.repo.ResourceForUser(userID, id)
	if resource != nil {
		resource.PublicURL = ""
	}
	return resource, err
}

func (s *Service) validateListedResource(resource *model.Resource) error {
	if resource == nil || !s.localStorage {
		return nil
	}
	if resource.Provider != "local" {
		return fmt.Errorf("资源 %s 不属于本地存储", resource.ID)
	}
	if resource.Status != model.ResourceStatusReady {
		return nil
	}
	if s.blobs == nil {
		return fmt.Errorf("资源 %s 的本地文件缺失", resource.ID)
	}
	if err := s.blobs.Exists(resource.ObjectKey); err != nil {
		return fmt.Errorf("资源 %s 的本地文件缺失", resource.ID)
	}
	return nil
}

func (s *Service) Upload(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	return s.upload(userID, header, kind, width, height, durationMs, uploadIdentity...)
}

func (s *Service) UploadLocal(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	return s.upload(userID, header, kind, width, height, durationMs, uploadIdentity...)
}

func (s *Service) upload(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	if header == nil {
		return nil, MissingUpload()
	}
	uploadIdentity = EnsureUploadIdentity(uploadIdentity)
	uploadKey := NormalizedUploadKey(uploadIdentity)
	existing, err := s.resourceForUploadKey(userID, uploadKey)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.Status == model.ResourceStatusReady {
		return existing, nil
	}
	file, err := header.Open()
	if err != nil {
		return nil, err
	}
	defer file.Close()
	mimeType := DetectUploadedMimeType(file, header.Filename, header.Header.Get("Content-Type"))
	if existing != nil {
		return s.Retry(userID, existing, kind, mimeType, header.Size, file)
	}
	identity := quotaIdentity(uploadKey, "")
	day, err := s.reserveUpload(userID, header.Size, identity)
	if err != nil {
		return nil, err
	}
	resource, created, err := s.Store(userID, kind, header.Filename, mimeType, header.Size, width, height, durationMs, file, uploadKey)
	s.finishQuota(userID, day, header.Size, resource, created, err, identity)
	return resource, err
}

func (s *Service) UploadFile(userID string, fileName string, size int64, kind string, width int, height int, durationMs int64, file io.ReadSeeker, uploadIdentity ...string) (*model.Resource, error) {
	return s.uploadFile(userID, fileName, size, kind, width, height, durationMs, file, uploadIdentity...)
}

func (s *Service) UploadLocalFile(userID string, fileName string, size int64, kind string, width int, height int, durationMs int64, file io.ReadSeeker, uploadIdentity ...string) (*model.Resource, error) {
	return s.uploadFile(userID, fileName, size, kind, width, height, durationMs, file, uploadIdentity...)
}

func (s *Service) uploadFile(userID string, fileName string, size int64, kind string, width int, height int, durationMs int64, file io.ReadSeeker, uploadIdentity ...string) (*model.Resource, error) {
	if file == nil || size <= 0 {
		return nil, MissingUpload()
	}
	uploadIdentity = EnsureUploadIdentity(uploadIdentity)
	uploadKey := NormalizedUploadKey(uploadIdentity)
	existing, err := s.resourceForUploadKey(userID, uploadKey)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.Status == model.ResourceStatusReady {
		return existing, nil
	}
	mimeType := DetectUploadedMimeType(file, fileName, "")
	if existing != nil {
		return s.Retry(userID, existing, kind, mimeType, size, file)
	}
	identity := quotaIdentity(uploadKey, "")
	day, err := s.reserveChunked(userID, size, identity)
	if err != nil {
		return nil, err
	}
	resource, created, err := s.Store(userID, kind, fileName, mimeType, size, width, height, durationMs, file, uploadKey)
	s.finishQuota(userID, day, size, resource, created, err, identity)
	return resource, err
}

// StoreGenerated persists one independent generated artifact under its own
// operation identity so concurrent inlines do not share a pending bucket.
func (s *Service) StoreGenerated(userID string, kind string, fileName string, mimeType string, size int64, width int, height int, durationMs int64, body io.Reader) (*model.Resource, error) {
	uploadKey := NormalizedUploadKey(EnsureUploadIdentity(nil))
	identity := quotaIdentity(uploadKey, "")
	day, err := s.reserveGenerated(userID, size, identity)
	if err != nil {
		return nil, err
	}
	resource, created, err := s.Store(userID, kind, fileName, mimeType, size, width, height, durationMs, body, uploadKey)
	s.finishQuota(userID, day, size, resource, created, err, identity)
	return resource, err
}

// IngestUpload stores a downloaded remote file under upload quota (single-file
// cap) with a stable or minted identity.
func (s *Service) IngestUpload(userID string, kind string, fileName string, mimeType string, size int64, width int, height int, durationMs int64, body io.Reader, uploadIdentity ...string) (*model.Resource, error) {
	if body == nil || size <= 0 {
		return nil, MissingUpload()
	}
	uploadIdentity = EnsureUploadIdentity(uploadIdentity)
	uploadKey := NormalizedUploadKey(uploadIdentity)
	existing, err := s.resourceForUploadKey(userID, uploadKey)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.Status == model.ResourceStatusReady {
		return existing, nil
	}
	if existing != nil {
		return s.Retry(userID, existing, kind, mimeType, size, body)
	}
	identity := quotaIdentity(uploadKey, "")
	day, err := s.reserveUpload(userID, size, identity)
	if err != nil {
		return nil, err
	}
	resource, created, err := s.Store(userID, kind, fileName, mimeType, size, width, height, durationMs, body, uploadKey)
	s.finishQuota(userID, day, size, resource, created, err, identity)
	return resource, err
}

func quotaIdentity(uploadKey *string, resourceID string) string {
	if uploadKey != nil {
		if key := strings.TrimSpace(*uploadKey); key != "" {
			return key
		}
	}
	return strings.TrimSpace(resourceID)
}

func (s *Service) reserveUpload(userID string, size int64, identity string) (string, error) {
	if s == nil || s.quota == nil {
		return "", nil
	}
	return mapQuotaReserveError(s.quota.ReserveUpload(userID, size, identity))
}

func (s *Service) reserveChunked(userID string, size int64, identity string) (string, error) {
	if s == nil || s.quota == nil {
		return "", nil
	}
	return mapQuotaReserveError(s.quota.ReserveChunked(userID, size, identity))
}

func (s *Service) reserveGenerated(userID string, size int64, identity string) (string, error) {
	if s == nil || s.quota == nil {
		return "", nil
	}
	return mapQuotaReserveError(s.quota.ReserveGenerated(userID, size, identity))
}

func (s *Service) reserveGeneratedRetry(userID string, size int64, identity string) (string, error) {
	if s == nil || s.quota == nil {
		return "", nil
	}
	return mapQuotaReserveError(s.quota.ReserveGeneratedRetry(userID, size, identity))
}

func mapQuotaReserveError(day string, err error) (string, error) {
	if err == nil {
		return day, nil
	}
	if errors.Is(err, repository.ErrUploadReservationConflict) {
		return "", UploadInProgress()
	}
	return "", err
}

func (s *Service) commitQuota(resource *model.Resource) {
	if s == nil || s.quota == nil || resource == nil {
		return
	}
	s.quota.Commit(resource.UserID, resource.Size, quotaIdentity(resource.UploadKey, resource.ID))
}

func (s *Service) finishQuota(userID string, day string, size int64, resource *model.Resource, created bool, err error, identity string) {
	if s == nil || s.quota == nil {
		return
	}
	if resource != nil && resource.Status == model.ResourceStatusReady {
		if created && err == nil {
			s.quota.Commit(userID, size, identity)
			return
		}
		// A live replay reserved after another handle already committed READY.
		// Drop the extra hold so daily bytes stay with the original consume.
		s.quota.Release(userID, day, size, identity)
		return
	}
	if resource != nil && resource.Status == model.ResourceStatusFailed {
		s.quota.Release(userID, day, size, identity)
		return
	}
	if resource != nil && (resource.Status == model.ResourceStatusPending || s.objectPresent(resource)) {
		return
	}
	s.quota.Release(userID, day, size, identity)
}

func (s *Service) resourceForUploadKey(userID string, uploadKey *string) (*model.Resource, error) {
	if uploadKey == nil || s == nil || s.repo == nil {
		return nil, nil
	}
	resource, err := s.repo.ResourceByUploadKey(userID, *uploadKey)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return resource, nil
}

func (s *Service) afterReady(resource *model.Resource) {
	if s == nil || s.lifecycle == nil || resource == nil {
		return
	}
	s.lifecycle.RecordActivity(resource.UserID, "resource", 1)
	s.lifecycle.AfterResourceReady(resource)
}

func (s *Service) workerID() string {
	if s != nil && s.lifecycle != nil {
		if id := s.lifecycle.WorkerID(); id != "" {
			return id
		}
	}
	return kernel.NewID()
}

func (s *Service) runBackground(fn func()) {
	if s == nil || s.lifecycle == nil || fn == nil {
		return
	}
	s.lifecycle.RunBackground(fn)
}
