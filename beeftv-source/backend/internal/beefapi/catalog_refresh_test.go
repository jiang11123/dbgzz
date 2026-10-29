package beefapi

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/workspace"
)

func TestRefreshCatalogPersistsTrustedPortraitPricesAcrossRestart(t *testing.T) {
	svc, store, dir := testService(t, &fakeEnterprise{})
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	before, _, _ := store.LoadEffectiveModelConfig()
	before.Config["assistantModel"] = "beefapi::chosen-assistant"
	before.Config["model"] = "custom::chosen-image"
	before.Config["videoModel"] = "custom::chosen-video"
	before.Config["textModel"] = "custom::chosen-text"
	custom := map[string]any{"id": "custom", "models": []any{"chosen-image", "chosen-video", "chosen-text"}, "modelProfiles": []any{map[string]any{"model": "chosen-video", "displayName": "My custom model"}}}
	before.Config["channels"] = append(before.Config["channels"].([]any), custom)
	body, _ := json.Marshal(before.Config)
	if err := store.SaveLocalModelConfig(body); err != nil {
		t.Fatal(err)
	}
	quote := json.RawMessage(`{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":69,"reference_video":42}}}`)
	catalog := []CatalogModel{
		{ID: "seedance-2.0-portrait", SupportedEndpointTypes: []string{"openai"}, VideoPricing: quote},
		{ID: "seedance-2.5-portrait", SupportedEndpointTypes: []string{"openai"}, VideoPricing: quote},
	}
	svc.fetchCatalog = func(apiKey, baseURL string) ([]CatalogModel, error) {
		if apiKey != "ent-secret-key" || baseURL != ProviderBaseURL(svc.origin) {
			t.Error("catalog did not use the saved connection")
		}
		return catalog, nil
	}
	models, err := svc.RefreshCatalog(context.Background())
	if err != nil || len(models) != 2 {
		t.Fatal("refresh failed", err)
	}
	encoded, _ := json.Marshal(models)
	if !strings.Contains(string(encoded), `"videoPricing"`) || strings.Contains(string(encoded), "ent-secret-key") {
		t.Fatal("catalog wire shape is invalid")
	}
	reopened, _ := workspace.NewProviderConfig(dir)
	current, _, err := reopened.LoadEffectiveModelConfig()
	if err != nil || current.Config["assistantModel"] != "beefapi::chosen-assistant" {
		t.Fatal("refresh did not preserve the chosen assistant", err)
	}
	for _, field := range []string{"model", "videoModel", "textModel"} {
		if current.Config[field] != before.Config[field] {
			t.Fatalf("refresh changed user selection %s", field)
		}
	}
	customBody, _ := json.Marshal(custom)
	currentCustomBody, _ := json.Marshal(findChannel(current.Config["channels"].([]any), "custom"))
	if string(currentCustomBody) != string(customBody) {
		t.Fatal("refresh changed custom channel")
	}
	channel := findChannel(current.Config["channels"].([]any), ChannelID)
	for _, id := range []string{"seedance-2.0-portrait", "seedance-2.5-portrait"} {
		profile := refreshTestProfile(channel, id)
		if profile == nil || profile["capability"] != "video" || profile["protocol"] != "newapi" || profile["videoPricing"] == nil {
			t.Fatalf("persisted catalog lacks trusted video profile for %s", id)
		}
	}
	forged := map[string]any{"channels": []any{map[string]any{"id": ChannelID, "models": []any{"client-only"}, "modelProfiles": []any{map[string]any{"model": "seedance-2.0-portrait", "videoPricing": "forged"}}}}}
	PreserveManagedChannel(forged, current.Config, true)
	preserved := findChannel(forged["channels"].([]any), ChannelID)
	if refreshTestProfile(preserved, "seedance-2.0-portrait")["videoPricing"] == "forged" {
		t.Fatal("client write replaced trusted quote")
	}
	// Missing prices and removed models must not survive the next successful read.
	catalog = []CatalogModel{{ID: "seedance-2.0-portrait", SupportedEndpointTypes: []string{"openai"}}}
	if _, err := svc.RefreshCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	current, _, _ = reopened.LoadEffectiveModelConfig()
	channel = findChannel(current.Config["channels"].([]any), ChannelID)
	if refreshTestProfile(channel, "seedance-2.0-portrait")["videoPricing"] != nil || refreshTestProfile(channel, "seedance-2.5-portrait") != nil {
		t.Fatal("stale portrait quote or removed model survived refresh")
	}
}

func TestSameAccountRefreshRemovesUnavailableModels(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first := []CatalogModel{{ID: "grok-imagine-video-1.5", ModelType: "video"}, {ID: "seedance-2.0-fast", ModelType: "video"}}
	if err := applyCatalog(store, first, "42", "42", ""); err != nil {
		t.Fatal(err)
	}
	for _, next := range [][]CatalogModel{{first[1]}, {}} {
		if err := applyCatalog(store, next, "42", "42", ""); err != nil {
			t.Fatal(err)
		}
		current, _, err := store.LoadEffectiveModelConfig()
		if err != nil {
			t.Fatal(err)
		}
		channel := findChannel(current.Config["channels"].([]any), ChannelID)
		ids := mergeModelIDs(channel["models"], nil)
		if len(ids) != len(next) || refreshTestProfile(channel, "grok-imagine-video-1.5") != nil {
			t.Fatalf("refresh kept unavailable models: %v", ids)
		}
	}
}

func TestRefreshCatalogRejectsDisconnectedErrorsAndCancelledReads(t *testing.T) {
	svc, store, _ := testService(t, &fakeEnterprise{})
	if _, err := svc.RefreshCatalog(context.Background()); err == nil {
		t.Fatal("disconnected refresh accepted")
	}
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	before, _, _ := store.LoadEffectiveModelConfig()
	calls := 0
	svc.fetchCatalog = func(string, string) ([]CatalogModel, error) {
		calls++
		return nil, errors.New("synthetic-private-provider-detail")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := svc.RefreshCatalog(ctx); err == nil || calls != 0 {
		t.Fatal("cancelled refresh dispatched")
	}
	if _, err := svc.RefreshCatalog(context.Background()); err == nil || strings.Contains(err.Error(), "synthetic-private-provider-detail") {
		t.Fatal("catalog failure was hidden or leaked provider detail")
	}
	after, _, _ := store.LoadEffectiveModelConfig()
	if after.Revision != before.Revision {
		t.Fatal("failed catalog read mutated configuration")
	}
}

func TestRefreshCatalogRejectsResultAfterDisconnect(t *testing.T) {
	svc, store, _ := testService(t, &fakeEnterprise{})
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	started, release := make(chan struct{}), make(chan struct{})
	svc.fetchCatalog = func(string, string) ([]CatalogModel, error) {
		close(started)
		<-release
		return []CatalogModel{{ID: "seedance-2.0-portrait"}}, nil
	}
	result := make(chan error, 1)
	go func() { _, err := svc.RefreshCatalog(context.Background()); result <- err }()
	<-started
	if _, err := svc.Disconnect(context.Background()); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-result; err == nil {
		t.Fatal("old account catalog accepted after disconnect")
	}
	current, _, _ := store.LoadEffectiveModelConfig()
	channel := findChannel(current.Config["channels"].([]any), ChannelID)
	if refreshTestProfile(channel, "seedance-2.0-portrait") != nil {
		t.Fatal("late catalog repopulated disconnected models")
	}
}

func refreshTestProfile(channel map[string]any, id string) map[string]any {
	profiles, _ := channel["modelProfiles"].([]any)
	for _, raw := range profiles {
		profile, _ := raw.(map[string]any)
		if profile["model"] == id {
			return profile
		}
	}
	return nil
}
