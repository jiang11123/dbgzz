package generation

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

type metadataResources struct {
	ResourcePort
	info  ResourceInfo
	err   error
	calls int
}

func (p *metadataResources) Lookup(string, string) (ResourceInfo, error) { return p.info, nil }
func (p *metadataResources) LocalMode() bool                             { return true }
func (p *metadataResources) EnsureMetadata(ctx context.Context, userID, id string) (ResourceInfo, error) {
	p.calls++
	if userID != "user-1" || id != "legacy" {
		return ResourceInfo{}, errors.New("wrong identity")
	}
	if p.err != nil {
		return ResourceInfo{}, p.err
	}
	info := p.info
	info.DurationMs = 1000
	return info, ctx.Err()
}

func TestMissingReferenceMetadataStopsBeforeUpstream(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer server.Close()
	resources := &metadataResources{info: ResourceInfo{ID: "legacy", Kind: "audio", Status: "ready"}, err: errors.New("probe unavailable")}
	ctx := WithRuntime(context.Background(), taskRuntime(func(r *Runtime) { r.Resources = resources }))
	_, err := Execute(ctx, Input{Mode: "video", Prompt: "animate", Config: Config{BaseURL: server.URL, APIKey: "key", Model: "video", InterfaceType: "newapi-channel-1"}, ReferenceAudios: []Media{{StorageKey: "resource:legacy", DurationMs: 9999}}})
	if err == nil || !strings.Contains(err.Error(), "probe unavailable") || resources.calls != 1 || hits.Load() != 0 {
		t.Fatalf("err=%v probes=%d upstream=%d", err, resources.calls, hits.Load())
	}
	resources.err = context.DeadlineExceeded
	_, err = Execute(ctx, Input{Mode: "video", Prompt: "animate", Config: Config{BaseURL: server.URL, APIKey: "key", Model: "video", InterfaceType: "newapi-channel-1"}, ReferenceAudios: []Media{{StorageKey: "resource:legacy"}}})
	failure := ClassifyError(err)
	if failure.Uncertain || failure.Category != CategoryInputInaccessible || hits.Load() != 0 {
		t.Fatalf("local preparation timeout reported as upstream uncertainty: %+v hits=%d", failure, hits.Load())
	}
}

func TestHydrateOwnedAudioUsesPersistedProbeOverClientDuration(t *testing.T) {
	resources := &metadataResources{info: ResourceInfo{ID: "legacy", Kind: "audio", Status: "ready"}}
	ctx := WithRuntime(context.Background(), taskRuntime(func(r *Runtime) { r.Resources = resources }))
	input := Input{ReferenceAudios: []Media{{StorageKey: "resource:legacy", DurationMs: 9999}}}
	if err := HydrateVideoReferenceMetadata(ctx, "user-1", &input); err != nil {
		t.Fatal(err)
	}
	if input.ReferenceAudios[0].DurationMs != 1000 || resources.calls != 1 {
		t.Fatalf("client facts survived: %+v", input)
	}
}
