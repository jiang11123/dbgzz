package plugins

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func TestProviderCatalogOverlaysOfficialRegistry(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, nil)
	catalog := svc.ProviderCatalog(string(protocol.SurfaceAdminSystemChannel), string(protocol.CapabilityVideo), false)
	var xai *ProviderCatalogItem
	var autoDL *ProviderCatalogItem
	for index := range catalog {
		switch catalog[index].ID {
		case "xai-video":
			xai = &catalog[index]
		case "autodl-comfyui":
			autoDL = &catalog[index]
		case "autodl-comfyui-plugin":
			t.Fatal("legacy AutoDL provider ID leaked into catalog")
		}
	}
	if xai == nil || xai.Create != "POST /v1/videos/generations" || strings.Contains(xai.Create, "__host__") {
		t.Fatalf("xAI catalog = %#v", xai)
	}
	if autoDL == nil || len(autoDL.Workflows) == 0 || autoDL.Enabled != true {
		t.Fatalf("AutoDL catalog = %#v", autoDL)
	}
}

func TestProviderCatalogHidesDisabledPlugins(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, nil)
	if _, err := svc.SetEnabled("xai-video", false); err != nil {
		t.Fatal(err)
	}
	hidden := svc.ProviderCatalog(string(protocol.SurfaceAdminSystemChannel), string(protocol.CapabilityVideo), false)
	for _, item := range hidden {
		if item.ID == "xai-video" {
			t.Fatalf("disabled plugin remained in catalog: %#v", item)
		}
	}
	visible := svc.ProviderCatalog(string(protocol.SurfaceAdminSystemChannel), string(protocol.CapabilityVideo), true)
	found := false
	for _, item := range visible {
		if item.ID == "xai-video" {
			found = true
			if item.Enabled {
				t.Fatalf("disabled plugin reported enabled: %#v", item)
			}
		}
	}
	if !found {
		t.Fatal("includeUnavailable omitted disabled xAI plugin")
	}
}

func TestProviderCatalogUsesPerRuntimeRegistry(t *testing.T) {
	leftRuntime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rightRuntime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	left := New(leftRuntime, nil)
	right := New(rightRuntime, nil)
	if _, err := left.SetEnabled("xai-video", false); err != nil {
		t.Fatal(err)
	}
	if item := findProvider(left.ProviderCatalog(string(protocol.SurfaceAdminSystemChannel), string(protocol.CapabilityVideo), false), "xai-video"); item != nil {
		t.Fatalf("left runtime still exposed disabled plugin: %#v", item)
	}
	if item := findProvider(right.ProviderCatalog(string(protocol.SurfaceAdminSystemChannel), string(protocol.CapabilityVideo), false), "xai-video"); item == nil || !item.Enabled {
		t.Fatalf("right runtime lost independent xAI catalog: %#v", item)
	}
}

func TestForUserHidesSystemPluginsWhenFeatureDisabled(t *testing.T) {
	svc := New(RuntimeForTest(map[string]Record{
		"bundled":  {Source: "bundled", Metadata: protocol.Metadata{ID: "bundled", Name: "系统协议", Version: "1"}},
		"uploaded": {Source: OriginUploaded, Metadata: protocol.Metadata{ID: "uploaded", Name: "自定义协议", Version: "1"}},
		"app":      {Source: "bundled", Metadata: protocol.Metadata{ID: WorkflowRunningHub, Name: "官方应用", Version: "1"}},
	}), nil)
	user := &model.User{ID: "user-1", Role: model.UserRoleUser}
	visible := svc.ForUser(user, false)
	if len(visible) != 1 || visible[0].Manifest.ID != WorkflowRunningHub {
		t.Fatalf("ForUser(user, hidden) = %#v", visible)
	}
	admin := svc.ForUser(&model.User{ID: "admin-1", Role: model.UserRoleAdmin}, false)
	if len(admin) != 3 {
		t.Fatalf("ForUser(admin) = %#v", admin)
	}
	all := svc.ForUser(user, true)
	if len(all) != 3 {
		t.Fatalf("ForUser(user, visible) = %#v", all)
	}
}

func TestProviderCatalogCustomPluginUsesManifestUntilRegistryOverlay(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, nil)
	plugin, err := svc.Install(testPluginPackage(t, testManifest("catalog-custom-video", "1.0.0")), "catalog-custom-video.beeftv-plugin")
	if err != nil {
		t.Fatal(err)
	}
	if plugin.Status != StatusEnabled {
		t.Fatalf("custom plugin status = %#v", plugin)
	}
	catalog := svc.ProviderCatalog(string(protocol.SurfaceCanvas), string(protocol.CapabilityVideo), false)
	item := findProvider(catalog, "catalog-custom-video")
	if item == nil || item.Create != "POST /tasks" || !item.Enabled {
		t.Fatalf("custom catalog = %#v", item)
	}
	if adapter, ok := svc.Registry().Resolve("catalog-custom-video"); !ok {
		t.Fatal("custom plugin missing from runtime registry")
	} else if metadata := adapter.Metadata(); item.Create != metadata.Create {
		t.Fatalf("catalog create %q != registry %q", item.Create, metadata.Create)
	}
}

func TestProviderCatalogProjectsAuthType(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, nil)
	raw := []byte(`{"apiVersion":"beeftv.plugin/v1","id":"catalog-auth-none","version":"1.0.0","name":"catalog-auth-none","author":"Test","documentation":"# catalog-auth-none","contributes":{"providers":[{"id":"catalog-auth-none","label":"catalog-auth-none","capabilities":["text"],"scopes":["canvas"],"auth":{"type":"none","field":"apiKey"},"create":{"method":"POST","path":"/api/chat","fields":{"prompt":"request.prompt"}},"response":{"statusPaths":["status"]}}]}}`)
	if _, err := svc.Install(testPluginPackage(t, raw), "catalog-auth-none.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	item := findProvider(svc.ProviderCatalog(string(protocol.SurfaceCanvas), string(protocol.CapabilityText), false), "catalog-auth-none")
	if item == nil || item.AuthType != "none" {
		t.Fatalf("auth catalog = %#v", item)
	}
}

func findProvider(items []ProviderCatalogItem, id string) *ProviderCatalogItem {
	for index := range items {
		if items[index].ID == id {
			return &items[index]
		}
	}
	return nil
}
