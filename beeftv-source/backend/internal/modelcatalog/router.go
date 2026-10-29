package modelcatalog

import (
	"context"
	"log"
	"sync"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

const (
	defaultRouteCatalogTTL      = 30 * time.Second
	defaultRouteCatalogMaxStale = 5 * time.Minute
	routeCatalogLoadTimeout     = 5 * time.Second
	routeCatalogRetryCooldown   = 2 * time.Second
)

type Router struct {
	loader      CatalogLoader
	clock       Clock
	invalidator CatalogInvalidator

	mu         sync.RWMutex
	refreshMu  sync.Mutex
	catalog    *RouteCatalog
	ttl        time.Duration
	maxStale   time.Duration
	version    int64
	retryAt    time.Time
	refreshErr error

	healthMu      sync.Mutex
	healthBlocked map[string]time.Time
}

func NewRouter(loader CatalogLoader, clock Clock, invalidator CatalogInvalidator, ttl, maxStale time.Duration) *Router {
	if clock == nil {
		clock = time.Now
	}
	if ttl <= 0 {
		ttl = defaultRouteCatalogTTL
	}
	if maxStale <= 0 {
		maxStale = defaultRouteCatalogMaxStale
	}
	return &Router{
		loader:        loader,
		clock:         clock,
		invalidator:   invalidator,
		ttl:           ttl,
		maxStale:      maxStale,
		healthBlocked: make(map[string]time.Time),
	}
}

func (r *Router) Invalidate(ctx context.Context) {
	if r == nil {
		return
	}
	r.refreshMu.Lock()
	r.mu.Lock()
	r.catalog = nil
	r.version++
	r.retryAt = time.Time{}
	r.refreshErr = nil
	r.mu.Unlock()
	r.refreshMu.Unlock()
	if r.invalidator != nil {
		r.invalidator(ctx)
	}
}

func (r *Router) Version() int64 {
	if r == nil {
		return 0
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.version
}

func (r *Router) Snapshot() (*RouteCatalog, error) {
	if r == nil || r.loader == nil {
		return nil, errCatalogUnavailable()
	}
	now := r.clock()
	version := r.Version()
	r.mu.RLock()
	snapshot := r.catalog
	if snapshot != nil && now.Sub(snapshot.LoadedAt) < r.ttl && snapshot.CatalogVersion == version {
		r.mu.RUnlock()
		return snapshot, nil
	}
	r.mu.RUnlock()

	r.refreshMu.Lock()
	defer r.refreshMu.Unlock()
	now = r.clock()
	version = r.Version()
	r.mu.RLock()
	snapshot = r.catalog
	if snapshot != nil && now.Sub(snapshot.LoadedAt) < r.ttl && snapshot.CatalogVersion == version {
		r.mu.RUnlock()
		return snapshot, nil
	}
	r.mu.RUnlock()

	if r.refreshErr != nil && now.Before(r.retryAt) {
		if snapshot != nil && snapshot.CatalogVersion == version && now.Sub(snapshot.LoadedAt) <= r.maxStale {
			return snapshot, nil
		}
		return nil, r.refreshErr
	}
	loaded, err := r.load(version)
	if err != nil {
		r.refreshErr = err
		r.retryAt = r.clock().Add(routeCatalogRetryCooldown)
		log.Printf("logical model route catalog refresh failed; retry cooled down: %v", err)
		if snapshot != nil && snapshot.CatalogVersion == version && now.Sub(snapshot.LoadedAt) <= r.maxStale {
			return snapshot, nil
		}
		return nil, err
	}
	r.refreshErr = nil
	r.retryAt = time.Time{}
	r.mu.Lock()
	r.catalog = loaded
	r.mu.Unlock()
	return loaded, nil
}

func (r *Router) load(version int64) (*RouteCatalog, error) {
	ctx, cancel := context.WithTimeout(context.Background(), routeCatalogLoadTimeout)
	defer cancel()
	items, graphs, channels, err := r.loader.Load(ctx)
	if err != nil {
		return nil, err
	}
	enabled := make(map[string]bool, len(channels))
	for _, channel := range channels {
		enabled[channel.ID] = true
	}
	return BuildRouteCatalog(r.clock(), version, items, graphs, enabled), nil
}

func BuildRouteCatalog(now time.Time, version int64, items []model.LogicalModel, graphs map[string]LogicalModelGraph, enabledSystemChannels map[string]bool) *RouteCatalog {
	snapshot := &RouteCatalog{LoadedAt: now, CatalogVersion: version, Models: make(map[string]CachedLogicalModel), Ordered: make([]string, 0, len(items))}
	for _, item := range items {
		graph, ok := graphs[item.ID]
		if !ok || graph.Revision == nil {
			log.Printf("logical model omitted from route catalog id=%s: graph unavailable", item.ID)
			continue
		}
		productSpec, decodeErr := DecodeCapabilitySpec(graph.Revision.CapabilitySpecJSON)
		if decodeErr != nil {
			log.Printf("logical model omitted from route catalog id=%s: invalid product capability: %v", item.ID, decodeErr)
			continue
		}
		channelModelByID := make(map[string]model.ChannelModel, len(graph.ChannelModels))
		for _, channelModel := range graph.ChannelModels {
			channelModelByID[channelModel.ID] = channelModel
		}
		cached := CachedLogicalModel{Model: item, Revision: *graph.Revision, ProductSpec: productSpec, Defaults: map[string]any{}}
		for _, route := range graph.Routes {
			channelModel, channelOK := channelModelByID[route.ChannelModelID]
			if !channelOK || !channelModel.Enabled || !enabledSystemChannels[channelModel.ChannelID] {
				continue
			}
			capabilitySpec, specErr := channelModelCapabilitySpec(channelModel)
			if specErr != nil {
				log.Printf("logical route omitted from catalog route_id=%s channel_model_id=%s: invalid capability: %v", route.ID, channelModel.ID, specErr)
				continue
			}
			cached.Routes = append(cached.Routes, CachedLogicalRoute{Route: route, CapabilitySpec: capabilitySpec, ChannelModel: channelModel})
		}
		productSpec = capabilitySpecWithRoutePresets(productSpec, EnabledLogicalRouteSpecs(cached.Routes))
		defaults, defaultsErr := DecodeLogicalDefaults(graph.Revision.DefaultOptionsJSON, productSpec)
		if defaultsErr != nil {
			log.Printf("logical model omitted from route catalog id=%s: invalid defaults: %v", item.ID, defaultsErr)
			continue
		}
		cached.ProductSpec = productSpec
		cached.Defaults = defaults
		snapshot.Models[item.ID] = cached
		snapshot.Ordered = append(snapshot.Ordered, item.ID)
	}
	return snapshot
}

func DecodeLogicalDefaults(raw string, spec CapabilitySpec) (map[string]any, error) {
	return decodeLogicalDefaults(raw, spec)
}

func errCatalogUnavailable() error {
	return kernel.BadAuthRequest("所选模型不可用")
}

// TestingReplaceSnapshot installs a catalog snapshot without clearing the
// refresh cooldown. Tests use it to prove same-version stale fallback.
func (r *Router) TestingReplaceSnapshot(snapshot *RouteCatalog) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.catalog = snapshot
	r.mu.Unlock()
}

// TestingSetVersion overwrites the local catalog generation. Tests use it to
// prove an invalidated generation is never served stale.
func (r *Router) TestingSetVersion(version int64) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.version = version
	r.mu.Unlock()
}
