package asset

import (
	"context"
	"io"
	"os"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// BlobStore is the crash-safe byte owner for local resources. FileStore is the
// canonical implementation; callers must not write resource files beside it.
type BlobStore interface {
	Write(objectKey string, body io.Reader) error
	Open(objectKey string) (*os.File, error)
	Delete(objectKey string) error
	Exists(objectKey string) error
}

// Repository is the durable metadata port for resource rows, deletion outbox,
// and live-reference snapshots. Adapters wrap repository.Repository.
type Repository interface {
	CreateResource(*model.Resource) error
	SaveResource(*model.Resource) error
	UpdateResourceMediaMetadata(context.Context, *model.Resource) error
	Resource(id string) (*model.Resource, error)
	ResourceForUser(userID string, id string) (*model.Resource, error)
	Resources(userID string, limit int) ([]model.Resource, error)
	ResourceByUploadKey(userID string, uploadKey string) (*model.Resource, error)
	ListUploadReservations() ([]model.UserUploadReservation, error)
	UploadReservation(userID string, identity string) (*model.UserUploadReservation, error)
	ClearUploadReservation(userID string, identity string) error
	ReleaseIdentifiedDailyUpload(userID string, day string, identity string, size int64) error
	ClaimFailedResourceUpload(userID string, id string) (bool, error)
	DeleteResource(userID string, id string) error
	ResourcesForUserIDs(userID string, resourceIDs []string) ([]model.Resource, error)
	ResourceStorageReferenceCount(resource *model.Resource, excludedResourceIDs []string) (int64, error)
	ResourceReferenceSnapshot(userID string, excludingAssetID string, resourceIDs []string) (repository.ResourceReferenceSnapshot, error)
	DeleteAssetAndResources(userID string, assetID string, resourceIDs []string, deletionJobs []model.ResourceDeletionJob, expectedStatus ...string) error
	DeleteDetachedResources(resources []model.Resource, deletionJobs []model.ResourceDeletionJob) error
	ResourceCleanupCandidates(incompleteBefore time.Time, readyBefore time.Time, limit int) ([]model.Resource, error)
	ClaimNextResourceDeletionJob(owner string, leaseDuration time.Duration) (*model.ResourceDeletionJob, error)
	CompleteResourceDeletionJob(id string, owner string) error
	RetryResourceDeletionJob(id string, owner string, lastError string, nextAttemptAt time.Time) error
	CanvasHistoryReferencesObject(resource *model.Resource) (bool, error)
	AssetForUser(userID string, assetID string) (*model.Asset, error)
	AssetBusinessReferences(userID string, assetID string) ([]repository.ResourceDirectReference, error)
	AssetResourceRecords(assetID string) ([]model.AssetVersion, []model.AssetRepresentation, error)
	FindExpiredArchivedAssets(cutoff time.Time, limit int) ([]model.Asset, error)
}

// Quota is implemented by the application upload-quota owner. The domain never
// accounts bytes itself. Upload and generated artifacts share the same daily
// and storage ledger; only the single-file cap differs. identity scopes the
// in-memory pending storage entry so Release/Commit apply to this
// resource/artifact reservation, not another request's. Retry reserves are
// daily-only and do not create pending entries. Commit is a no-op when this
// identity has no pending reservation.
type Quota interface {
	ReserveUpload(userID string, size int64, identity string) (day string, err error)
	ReserveChunked(userID string, size int64, identity string) (day string, err error)
	ReserveRetry(userID string, size int64, identity string) (day string, err error)
	ReserveGenerated(userID string, size int64, identity string) (day string, err error)
	ReserveGeneratedRetry(userID string, size int64, identity string) (day string, err error)
	Release(userID string, day string, size int64, identity string)
	ReleaseRetry(userID string, day string, size int64, identity string)
	Commit(userID string, size int64, identity string)
}

// Lifecycle is the typed application seam for activity, playback, appearance
// references, recycle-bin policy, and background work. Methods are the port;
// the application adapter is a concrete type, not a bag of callbacks.
type Lifecycle interface {
	RecordActivity(userID string, kind string, count int)
	AfterResourceReady(resource *model.Resource)
	AppearanceReferencedIDs(resourceIDs []string) map[string]struct{}
	RecycleRetentionDays() (int, error)
	WorkerID() string
	RunBackground(func())
	DeleteUserAsset(userID string, assetID string) error
	WithStorageLock(func() error) error
}

// Dependencies constructs the durable resource domain.
type Dependencies struct {
	Repository   Repository
	Blobs        BlobStore
	Quota        Quota
	Lifecycle    Lifecycle
	LocalStorage bool
	DataDir      string
}
