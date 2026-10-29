package taskdelivery

import (
	"errors"

	"infinite-canvas/backend/internal/model"
)

var (
	ErrNotFound           = errors.New("generation delivery record not found")
	ErrForeignAsset       = errors.New("generation asset belongs to another user")
	ErrForeignResource    = errors.New("generation resource belongs to another user")
	ErrResourceMissing    = errors.New("generation resource missing")
	ErrResourceNotReady   = errors.New("generation resource is not ready")
	ErrDeliveryUnreadable = errors.New("generation delivery records are unreadable")
)

// Store is the durable ownership boundary for generation delivery.
// Implementations must run WithTx callbacks on one database transaction.
type Store interface {
	WithTx(func(Store) error) error
	GenerationOutputResults(taskID string) ([]model.Result, error)
	GenerationOutputResultsForTasks(taskIDs []string) ([]model.Result, error)
	AssetRepresentationsForTask(taskID string) ([]model.AssetRepresentation, error)
	ResourceForUser(userID, id string) (*model.Resource, error)
	Resource(id string) (*model.Resource, error)
	Asset(id string) (*model.Asset, error)
	AssetVersion(id string) (*model.AssetVersion, error)
	CommitOwned(OwnedDelivery) error
	SucceededTasksForDelivery(afterID string, limit int) ([]model.Task, error)
}

// Media persists leftover upstream artifacts through the existing generated
// resource pipeline. It must not submit a new provider generation.
// First-stage inline dataURL/byte ingest is Ingestor, not this interface:
// ingest rewrites ResultJSON before durable task completion; Deliver later
// materializes assets from those resource IDs. The stages are complementary.
type Media interface {
	PersistRemoteArtifact(userID, mediaType, artifactURL, identity string) (*model.Resource, error)
}

// Canvas binding stays intent-only in Result.targetBinding / CanvasBindingIntent.
// assistantturns owns schema version 10; do not reserve a delivery migration.
// A later atomic canvas apply-ack table, if needed, waits for the next free version.

type OwnedDelivery struct {
	Result         model.Result
	Asset          *model.Asset
	Version        *model.AssetVersion
	Representation *model.AssetRepresentation
}
