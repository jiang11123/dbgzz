package modelcatalog

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

type countingLoader struct {
	n   atomic.Int32
	err error
}

func (l *countingLoader) Load(context.Context) ([]model.LogicalModel, map[string]LogicalModelGraph, []model.ModelChannel, error) {
	l.n.Add(1)
	return nil, nil, nil, l.err
}

func TestRouteCatalogFailureStormAndInvalidatedStaleSnapshot(t *testing.T) {
	wantErr := errors.New("injected database outage")
	loader := &countingLoader{err: wantErr}
	router := NewRouter(loader, time.Now, nil, time.Second, time.Minute)
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := router.Snapshot(); !errors.Is(err, wantErr) {
				t.Errorf("outage error lost: %v", err)
			}
		}()
	}
	wg.Wait()
	if loader.n.Load() != 1 {
		t.Fatalf("failure storm retried DB %d times", loader.n.Load())
	}
	router.TestingReplaceSnapshot(&RouteCatalog{LoadedAt: time.Now().Add(-2 * time.Second), CatalogVersion: 0})
	if _, err := router.Snapshot(); err != nil {
		t.Fatalf("existing same-version bounded fallback lost: %v", err)
	}
	router.TestingSetVersion(1)
	if _, err := router.Snapshot(); !errors.Is(err, wantErr) {
		t.Fatal("explicitly invalidated version was served stale")
	}
	router.Invalidate(context.Background())
	if _, err := router.Snapshot(); !errors.Is(err, wantErr) {
		t.Fatal(err)
	}
	if loader.n.Load() != 2 {
		t.Fatal("invalidation failed to reset refresh cooldown")
	}
}

func TestWeightedRouteSingleCandidate(t *testing.T) {
	route := CachedLogicalRoute{Route: model.LogicalModelRoute{ID: "r1", Weight: 3, Priority: 1, Enabled: true}}
	if got := WeightedRoute([]CachedLogicalRoute{route}); got.Route.ID != "r1" {
		t.Fatalf("WeightedRoute() = %#v", got)
	}
}

func TestBlockLogicalRouteForFailure(t *testing.T) {
	now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	router := NewRouter(nil, func() time.Time { return now }, nil, time.Second, time.Minute)
	route := CachedLogicalRoute{Route: model.LogicalModelRoute{ID: "r1"}, ChannelModel: model.ChannelModel{ID: "cm1", ChannelID: "ch1"}}
	if router.LogicalRouteBlocked(route) {
		t.Fatal("empty health map blocked a route")
	}
	router.BlockLogicalRouteForFailure(&model.RouteAttempt{FailureCode: "upstream_401", ChannelID: "ch1"}, FailureInfo{StatusCode: 401})
	if !router.LogicalRouteBlocked(route) {
		t.Fatal("401 did not block the channel")
	}
	now = now.Add(11 * time.Minute)
	if router.LogicalRouteBlocked(route) {
		t.Fatal("expired 401 block still applied")
	}
}

func TestSafeRouteRejectionAndFailureCode(t *testing.T) {
	if !SafeRouteRejection(FailureInfo{StatusCode: 402}) {
		t.Fatal("HTTP 402 should be a safe rejection")
	}
	if SafeRouteRejection(FailureInfo{ImageRecovery: true, StatusCode: 429}) {
		t.Fatal("image recovery must not be a safe rejection")
	}
	if got := RouteFailureCode(FailureInfo{SlotCode: "slot_busy"}); got != "slot_busy" {
		t.Fatalf("RouteFailureCode slot = %q", got)
	}
	if got := RouteFailureCode(FailureInfo{StatusCode: 402}); got != "upstream_402" {
		t.Fatalf("RouteFailureCode 402 = %q", got)
	}
}
