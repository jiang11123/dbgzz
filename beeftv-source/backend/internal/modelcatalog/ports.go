package modelcatalog

import (
	"context"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

// ProtocolMeta is the slice of protocol.Metadata that catalog/channel rules
// actually consult. The protocol plugin worker owns the live registry.
type ProtocolMeta struct {
	ID                string
	Enabled           bool
	UnavailableReason string
	PrimaryCapability string
}

// ProtocolLookup resolves a protocol id (including official aliases) to metadata.
type ProtocolLookup func(id string) (ProtocolMeta, bool)

// ChannelModelLookup loads one configured channel model by channel and key.
type ChannelModelLookup func(channelID, modelKey string) (*model.ChannelModel, error)

// IDGen allocates a prefixed persistence identity.
type IDGen func(prefix string) (string, error)

// Clock returns the current time for cache, health, and attempt timestamps.
type Clock func() time.Time

// CatalogLoader loads the enabled logical-model graph used by the route cache.
type CatalogLoader interface {
	Load(ctx context.Context) (items []model.LogicalModel, graphs map[string]LogicalModelGraph, channels []model.ModelChannel, err error)
}

// CatalogInvalidator runs after a local cache bump (distributed version + read caches).
type CatalogInvalidator func(ctx context.Context)

// RouteStore persists route attempts and the task fields they mutate.
type RouteStore interface {
	NextPrefixedID(prefix string) (string, error)
	CreateRouteAttempt(*model.RouteAttempt) error
	SaveRouteAttempt(*model.RouteAttempt) error
	MarkRouteAttemptDispatching(id string) error
	RouteAttempts(taskID string, routeRun int) ([]model.RouteAttempt, error)
	ChannelModelByID(channelID, id string) (*model.ChannelModel, error)
	ChannelModel(id string) (*model.ChannelModel, error)
	LogicalModel(id string) (*model.LogicalModel, error)
	LogicalModelRevision(id string) (*model.LogicalModelRevision, error)
	LogicalModelRoute(id string) (*model.LogicalModelRoute, error)
	LogicalModelRoutes(revisionID string, includeDisabled bool) ([]model.LogicalModelRoute, error)
	ChannelModelsByIDs(ids []string) ([]model.ChannelModel, error)
	SystemChannel(id string) (*model.ModelChannel, error)
	SystemChannelsByIDs(ids []string, includeDisabled bool) ([]model.ModelChannel, error)
	SwitchTaskLogicalRoute(taskID, expectedRouteID, routeID, inputJSON, channelModelID string) error
	UpdateTaskProviderState(taskID, providerRequestID, pollStage string, nextPollAt *time.Time) error
}

// TaskInputCodec is the task-worker seam used when switching routes.
type TaskInputCodec struct {
	Decrypt            func(raw string) (string, error)
	ProtectSecrets     func(input any) error
	ValidateCapability func(input map[string]any) error
}

// CatalogFetcher performs the safe outbound GET for /models. The outbound
// adapter owns the HTTP client, SSRF checks, headers, and URL joining; this
// domain owns validate, parse, merge, and capability overlay.
type CatalogFetcher func(ctx context.Context, baseURL, apiFormat, apiKey string, headers []ChannelHeader) ([]byte, error)

// CatalogExtraSource supplies vendor catalog entries after the standard
// /models fetch. The source must not perform HTTP or hold secrets.
type CatalogExtraSource func(baseURL, apiFormat string, headers []ChannelHeader) []ChannelModelCatalogItem

// LookupFromRegistry adapts protocol.Registry.Resolve without exposing Adapter.
func LookupFromRegistry(registry *protocol.Registry) ProtocolLookup {
	if registry == nil {
		return func(string) (ProtocolMeta, bool) { return ProtocolMeta{}, false }
	}
	return func(id string) (ProtocolMeta, bool) {
		adapter, ok := registry.Resolve(strings.TrimSpace(id))
		if !ok {
			return ProtocolMeta{}, false
		}
		metadata := adapter.Metadata()
		primary := ""
		if len(metadata.Categories) > 0 {
			primary = string(metadata.Categories[0])
		}
		return ProtocolMeta{
			ID:                metadata.ID,
			Enabled:           metadata.Enabled,
			UnavailableReason: metadata.UnavailableReason,
			PrimaryCapability: primary,
		}, true
	}
}
