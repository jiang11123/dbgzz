package plugins

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func TestRuntimeLoadsOfficialPackagesAndBundledWorkflow(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	items := runtime.List()
	if len(items) == 0 {
		t.Fatal("runtime loaded no plugins; build plugin-packages first")
	}
	foundWorkflow := false
	foundOfficial := false
	for _, item := range items {
		if item.Manifest.ID == WorkflowRunningHub {
			foundWorkflow = true
			if item.Source != OriginOfficial {
				t.Fatalf("workflow source = %q", item.Source)
			}
			if item.Status != StatusDisabled {
				t.Fatalf("bundled workflow default status = %q", item.Status)
			}
		}
		if item.Source == OriginOfficial && strings.HasSuffix(item.FileName, protocol.PluginPackageExtension) {
			foundOfficial = true
		}
	}
	if !foundWorkflow {
		t.Fatal("bundled RunningHub workflow missing")
	}
	if !foundOfficial {
		t.Fatal("no official packaged plugin loaded; run plugin-packages/build-packages.sh")
	}
}

func TestInstallRejectsOfficialPackageCollision(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var official View
	for _, item := range runtime.List() {
		if item.Source == OriginOfficial && strings.HasSuffix(item.FileName, protocol.PluginPackageExtension) {
			official = item
			break
		}
	}
	if official.Manifest.ID == "" {
		t.Fatal("no official protocol plugin to collide with; run plugin-packages/build-packages.sh")
	}
	manifest := testManifest(official.Manifest.ID, "1.0.0")
	_, err = runtime.Install(testPluginPackage(t, manifest), official.Manifest.ID+".beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "不能通过上传覆盖") {
		t.Fatalf("official collision error = %v", err)
	}
}

func TestInstallRejectsMalformedPackages(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Install(nil, "empty.beeftv-plugin"); err == nil {
		t.Fatal("empty package accepted")
	}
	if _, err := runtime.Install([]byte("not-a-zip"), "broken.beeftv-plugin"); err == nil {
		t.Fatal("non-zip package accepted")
	}
	if _, err := runtime.Install([]byte(`{"apiVersion":"beeftv.plugin/v1"}`), "legacy.json"); err == nil {
		t.Fatal("bare JSON manifest accepted")
	}
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	file, err := writer.Create("readme.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("no manifest")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Install(buffer.Bytes(), "missing-manifest.beeftv-plugin"); err == nil {
		t.Fatal("zip without manifest.json accepted")
	}
	if _, err := runtime.Install(testPluginPackage(t, []byte(`{"apiVersion":`)), "truncated.beeftv-plugin"); err == nil {
		t.Fatal("truncated manifest accepted")
	}
}

func TestInstallCustomUpdateAndDisabledRecovery(t *testing.T) {
	dataDir := t.TempDir()
	runtime, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	plugin, err := runtime.Install(testPluginPackage(t, testManifest("uploaded-runtime", "1.0.0")), "uploaded-runtime.beeftv-plugin")
	if err != nil {
		t.Fatal(err)
	}
	if plugin.Status != StatusEnabled || plugin.Source != OriginUploaded {
		t.Fatalf("installed plugin = %#v", plugin)
	}
	if !runtime.Registry().IsCapability("uploaded-runtime", protocol.CapabilityVideo) {
		t.Fatal("installed plugin was not registered")
	}
	updated, err := runtime.Install(testPluginPackage(t, testManifest("uploaded-runtime", "2.0.0")), "uploaded-runtime-v2.beeftv-plugin")
	if err != nil || updated.Manifest.Version != "2.0.0" {
		t.Fatalf("update = %#v, err = %v", updated, err)
	}
	if _, err := runtime.SetEnabled("uploaded-runtime", false); err != nil {
		t.Fatal(err)
	}
	if runtime.Registry().IsCapability("uploaded-runtime", protocol.CapabilityVideo) {
		t.Fatal("disabled plugin remained selectable")
	}
	restarted, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	disabled, ok := ByID(restarted.List(), "uploaded-runtime")
	if !ok || disabled.Status != StatusDisabled {
		t.Fatalf("disabled recovery = %#v ok=%v", disabled, ok)
	}
	adapter, ok := restarted.Registry().Resolve("uploaded-runtime")
	if !ok || adapter.Metadata().Enabled {
		t.Fatal("disabled plugin bypassed registry snapshot after restart")
	}
}

func TestMutationRollsBackWhenReloadFails(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	before := ids(runtime.List())
	runtime.failNextCommit(errors.New("forced reload failure"))
	_, err = runtime.Install(testPluginPackage(t, testManifest("atomic-install", "1.0.0")), "atomic-install.beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "forced reload failure") {
		t.Fatalf("install error = %v", err)
	}
	if got := ids(runtime.List()); !sameIDs(got, before) {
		t.Fatalf("install rollback list = %#v, want %#v", got, before)
	}

	plugin, err := runtime.Install(testPluginPackage(t, testManifest("atomic-toggle", "1.0.0")), "atomic-toggle.beeftv-plugin")
	if err != nil {
		t.Fatal(err)
	}
	if plugin.Status != StatusEnabled {
		t.Fatalf("toggle fixture status = %s", plugin.Status)
	}
	runtime.failNextCommit(errors.New("forced enable failure"))
	if _, err := runtime.SetEnabled("atomic-toggle", false); err == nil || !strings.Contains(err.Error(), "forced enable failure") {
		t.Fatalf("setEnabled error = %v", err)
	}
	still, ok := ByID(runtime.List(), "atomic-toggle")
	if !ok || still.Status != StatusEnabled {
		t.Fatalf("setEnabled rollback = %#v", still)
	}

	runtime.failNextCommit(errors.New("forced uninstall failure"))
	if err := runtime.Uninstall("atomic-toggle"); err == nil || !strings.Contains(err.Error(), "forced uninstall failure") {
		t.Fatalf("uninstall error = %v", err)
	}
	if _, ok := ByID(runtime.List(), "atomic-toggle"); !ok {
		t.Fatal("uninstall rollback dropped the plugin")
	}
}

func TestConcurrentReloadAndMutation(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var start sync.WaitGroup
	var work sync.WaitGroup
	start.Add(1)
	errorsCh := make(chan error, 12)
	for i := 0; i < 8; i++ {
		work.Add(1)
		go func() {
			defer work.Done()
			start.Wait()
			for n := 0; n < 20; n++ {
				_ = runtime.List()
				if registry := runtime.Registry(); registry != nil {
					_ = registry.List("", "", true)
				}
			}
		}()
	}
	for i := 0; i < 3; i++ {
		work.Add(1)
		id := fmt.Sprintf("concurrent-upload-%d", i)
		go func(pluginID string) {
			defer work.Done()
			start.Wait()
			_, err := runtime.Install(testPluginPackage(t, testManifest(pluginID, "1.0.0")), pluginID+".beeftv-plugin")
			if err != nil {
				errorsCh <- err
				return
			}
			if _, err := runtime.SetEnabled(pluginID, false); err != nil {
				errorsCh <- err
				return
			}
			if _, err := runtime.SetEnabled(pluginID, true); err != nil {
				errorsCh <- err
			}
		}(id)
	}
	start.Done()
	work.Wait()
	close(errorsCh)
	for err := range errorsCh {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("concurrent-upload-%d", i)
		item, ok := ByID(runtime.List(), id)
		if !ok || item.Status != StatusEnabled {
			t.Fatalf("concurrent plugin %s = %#v ok=%v", id, item, ok)
		}
		if !runtime.Registry().IsCapability(id, protocol.CapabilityVideo) {
			t.Fatalf("concurrent plugin %s missing from registry", id)
		}
	}
}

func TestDisabledOfficialStateSurvivesRestart(t *testing.T) {
	dataDir := t.TempDir()
	runtime, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	var officialID string
	for _, item := range runtime.List() {
		if item.Source == OriginOfficial && item.Status == StatusEnabled && strings.HasSuffix(item.FileName, protocol.PluginPackageExtension) {
			officialID = item.Manifest.ID
			break
		}
	}
	if officialID == "" {
		t.Fatal("no enabled official plugin; run plugin-packages/build-packages.sh")
	}
	if _, err := runtime.SetEnabled(officialID, false); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(restarted.List(), officialID)
	if !ok || item.Status != StatusDisabled {
		t.Fatalf("restarted official plugin = %#v", item)
	}
}

func TestRuntimeDropsRemovedOfficialProtocol(t *testing.T) {
	staleManifest := json.RawMessage(`{"apiVersion":"beeftv.plugin/v2","id":"removed-official-protocol","version":"1.0.0","name":"Removed Official Protocol","author":"Test","documentation":"# Removed\n\n## BeefTV运行时合同","contributes":{"providers":[{"id":"removed-official-protocol","label":"Removed","capabilities":["video"],"scopes":["canvas"],"create":{"method":"POST","path":"/tasks","body":{"prompt":{"$ref":"request.prompt"}}},"response":{"status":"pending"}}]}}`)
	registryData, err := json.Marshal([]RegistryRecord{{ID: "removed-official-protocol", Raw: staleManifest, Source: OriginOfficial}})
	if err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "plugin_registry.json"), registryData, 0o600); err != nil {
		t.Fatal(err)
	}
	runtime, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := runtime.Registry().Resolve("removed-official-protocol"); ok {
		t.Fatal("removed official protocol survived bootstrap")
	}
}

func TestSameBytesReinstallKeepsLiveBlobWhenReloadFails(t *testing.T) {
	dataDir := t.TempDir()
	runtime, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	pkg := testPluginPackage(t, testManifest("same-bytes-reload", "1.0.0"))
	if _, err := runtime.Install(pkg, "same-bytes-reload.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime.failNextCommit(errors.New("forced same-bytes reload failure"))
	if _, err := runtime.Install(pkg, "same-bytes-reload.beeftv-plugin"); err == nil || !strings.Contains(err.Error(), "forced same-bytes reload failure") {
		t.Fatalf("same-bytes reload error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "same-bytes-reload", "1.0.0", StatusEnabled, pkg)
	assertPackageBytes(t, runtime, dataDir, "same-bytes-reload", pkg)
	assertBlobExists(t, runtime, pkg, true)
}

func TestSameBytesReinstallKeepsLiveBlobWhenWriteFails(t *testing.T) {
	dataDir := t.TempDir()
	runtime, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	pkg := testPluginPackage(t, testManifest("same-bytes-write", "1.0.0"))
	if _, err := runtime.Install(pkg, "same-bytes-write.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime.failNextWriteRegistry(errors.New("forced same-bytes write failure"))
	if _, err := runtime.Install(pkg, "same-bytes-write.beeftv-plugin"); err == nil || !strings.Contains(err.Error(), "forced same-bytes write failure") {
		t.Fatalf("same-bytes write error = %v", err)
	}
	assertPackageBytes(t, runtime, dataDir, "same-bytes-write", pkg)
	restarted, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(restarted.List(), "same-bytes-write")
	if !ok || item.Manifest.Version != "1.0.0" || item.Status != StatusEnabled {
		t.Fatalf("restarted same-bytes plugin = %#v", item)
	}
}

func TestListReturnsDefensiveCopiesOfMutableMetadata(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	pkg := testPluginPackage(t, testManifestWithMutableMetadata("copy-semantics", "1.0.0"))
	if _, err := runtime.Install(pkg, "copy-semantics.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "copy-semantics")
	if !ok {
		t.Fatal("installed plugin missing from list")
	}
	if len(item.Manifest.Surfaces) == 0 || len(item.Manifest.Permissions) == 0 {
		t.Fatalf("missing slices: %#v", item.Manifest)
	}
	if len(item.Manifest.Contributes.Providers) == 0 || item.Manifest.Contributes.Providers[0].Create.Fields == nil || item.Manifest.Contributes.Providers[0].Create.Headers == nil {
		t.Fatalf("missing provider fields: %#v", item.Manifest.Contributes)
	}
	if len(item.Manifest.Contributes.Workflows) == 0 || item.Manifest.Contributes.Workflows[0].Defaults == nil {
		t.Fatalf("missing workflow defaults: %#v", item.Manifest.Contributes)
	}
	if len(item.Manifest.Contributes.CanvasNodes) == 0 || item.Manifest.Contributes.CanvasNodes[0].DefaultSize == nil || item.Manifest.Contributes.CanvasNodes[0].Schema == nil {
		t.Fatalf("missing canvas maps: %#v", item.Manifest.Contributes)
	}
	item.Manifest.Surfaces[0] = "mutated-surface"
	item.Manifest.Permissions[0] = "mutated-permission"
	item.Manifest.Contributes.Providers[0].Create.Fields["prompt"] = "mutated"
	item.Manifest.Contributes.Providers[0].Create.Headers["X-Test"] = "mutated"
	item.Manifest.Contributes.Workflows[0].Defaults["style"] = "mutated"
	item.Manifest.Contributes.CanvasNodes[0].DefaultSize["width"] = 1
	item.Manifest.Contributes.CanvasNodes[0].Schema["type"] = "mutated"

	again, ok := ByID(runtime.List(), "copy-semantics")
	if !ok {
		t.Fatal("plugin missing after mutating list copy")
	}
	if again.Manifest.Surfaces[0] == "mutated-surface" || again.Manifest.Permissions[0] == "mutated-permission" {
		t.Fatalf("list aliased slices: %#v", again.Manifest)
	}
	if again.Manifest.Contributes.Providers[0].Create.Fields["prompt"] == "mutated" {
		t.Fatalf("list aliased create fields: %#v", again.Manifest.Contributes.Providers[0].Create.Fields)
	}
	if again.Manifest.Contributes.Providers[0].Create.Headers["X-Test"] == "mutated" {
		t.Fatalf("list aliased headers: %#v", again.Manifest.Contributes.Providers[0].Create.Headers)
	}
	if again.Manifest.Contributes.Workflows[0].Defaults["style"] == "mutated" {
		t.Fatalf("list aliased workflow defaults: %#v", again.Manifest.Contributes.Workflows[0].Defaults)
	}
	if again.Manifest.Contributes.CanvasNodes[0].DefaultSize["width"] == 1 {
		t.Fatalf("list aliased defaultSize: %#v", again.Manifest.Contributes.CanvasNodes[0].DefaultSize)
	}
	if again.Manifest.Contributes.CanvasNodes[0].Schema["type"] == "mutated" {
		t.Fatalf("list aliased schema: %#v", again.Manifest.Contributes.CanvasNodes[0].Schema)
	}
}

func TestClonePluginViewJSONFailureDoesNotLeakAliases(t *testing.T) {
	defaults := map[string]any{"style": "film"}
	view := View{
		Manifest: ManifestView{
			ID:      "clone-fail",
			Name:    "clone-fail",
			Version: "1.0.0",
			Configuration: protocol.ManifestConfiguration{
				Fields: []protocol.ManifestField{{Name: "bad", Default: make(chan int)}},
			},
			Contributes: protocol.ManifestContributions{
				Workflows: []protocol.ManifestWorkflow{{ID: "wf", Defaults: defaults}},
			},
		},
	}
	cloned := clonePluginView(view)
	if cloned.Manifest.ID != "clone-fail" || cloned.Manifest.Version != "1.0.0" {
		t.Fatalf("sanitized view dropped identity: %#v", cloned.Manifest)
	}
	if cloned.Manifest.Configuration.Fields != nil {
		t.Fatalf("clone leaked configuration: %#v", cloned.Manifest.Configuration)
	}
	if cloned.Manifest.Contributes.Workflows != nil {
		t.Fatalf("clone leaked contributes: %#v", cloned.Manifest.Contributes)
	}
	if cloned.Error != "插件清单无法展示" {
		t.Fatalf("clone failure error = %q", cloned.Error)
	}
	defaults["style"] = "mutated"
	view.Manifest.Contributes.Workflows[0].Defaults["style"] = "mutated-again"
	if cloned.Manifest.Contributes.Workflows != nil {
		t.Fatal("clone acquired aliases after mutating the original")
	}
}

func testManifest(id, version string) []byte {
	return []byte(fmt.Sprintf(`{"apiVersion":"beeftv.plugin/v1","id":%q,"version":%q,"name":%q,"author":"Test","documentation":"# %s","contributes":{"providers":[{"id":%q,"label":%q,"capabilities":["video"],"scopes":["canvas"],"create":{"method":"POST","path":"/tasks","fields":{"prompt":"request.prompt"}},"response":{"statusPaths":["status"]}}]}}`, id, version, id, id, id, id))
}

func testManifestWithMutableMetadata(id, version string) []byte {
	return []byte(fmt.Sprintf(`{"apiVersion":"beeftv.plugin/v1","id":%q,"version":%q,"name":%q,"author":"Test","documentation":"# %s","surfaces":["canvas","settings"],"permissions":["network"],"contributes":{"providers":[{"id":%q,"label":%q,"capabilities":["video"],"scopes":["canvas"],"create":{"method":"POST","path":"/tasks","fields":{"prompt":"request.prompt"},"headers":{"X-Test":"one"},"query":{"mode":"fast"}},"response":{"statusPaths":["status"]}}],"workflows":[{"id":%q,"label":"WF","providerId":%q,"capability":"video","defaults":{"style":"film"}}],"canvasNodes":[{"id":%q,"label":"Node","defaultTitle":"Node","defaultSize":{"width":320,"height":200},"schema":{"type":"object"},"renderer":"declarative"}]}}`, id, version, id, id, id, id, id+"-wf", id, id+"-node"))
}

func assertImmediatePlugin(t *testing.T, runtime *Runtime, pluginID, version, status string, want []byte) {
	t.Helper()
	item, ok := ByID(runtime.List(), pluginID)
	if !ok || item.Manifest.Version != version || item.Status != status {
		t.Fatalf("live plugin %s = %#v ok=%v want version=%s status=%s", pluginID, item, ok, version, status)
	}
	got, _, err := runtime.Package(pluginID)
	if err != nil {
		t.Fatalf("live package %s: %v", pluginID, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("live package %s bytes changed", pluginID)
	}
	if runtime.Registry() == nil {
		t.Fatal("live registry is nil")
	}
	selectable := runtime.Registry().IsCapability(pluginID, protocol.CapabilityVideo)
	if status == StatusEnabled && !selectable {
		t.Fatalf("live registry missing enabled plugin %s", pluginID)
	}
	if status != StatusEnabled && selectable {
		t.Fatalf("live registry still selects %s", pluginID)
	}
}

func assertPackageBytes(t *testing.T, runtime *Runtime, dataDir, pluginID string, want []byte) {
	t.Helper()
	got, _, err := runtime.Package(pluginID)
	if err != nil {
		t.Fatalf("package %s: %v", pluginID, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("package %s bytes changed", pluginID)
	}
	var restarted *Runtime
	if runtime.store != nil {
		restarted, err = NewRuntimeWithStore(dataDir, runtime.store)
	} else {
		restarted, err = NewRuntime(dataDir)
	}
	if err != nil {
		t.Fatal(err)
	}
	got, _, err = restarted.Package(pluginID)
	if err != nil {
		t.Fatalf("restart package %s: %v", pluginID, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("restarted package %s bytes changed", pluginID)
	}
}

func assertBlobExists(t *testing.T, runtime *Runtime, data []byte, want bool) {
	t.Helper()
	name := blobFileName(pluginHash(data))
	_, err := os.Stat(filepath.Join(runtime.packageDir, name))
	if want {
		if err != nil {
			t.Fatalf("blob %s missing: %v", name, err)
		}
		return
	}
	if err == nil {
		t.Fatalf("blob %s still present", name)
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("blob %s stat: %v", name, err)
	}
}

func testPluginPackage(t *testing.T, manifest []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	file, err := writer.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(manifest); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func ids(items []View) []string {
	result := make([]string, 0, len(items))
	for _, item := range items {
		result = append(result, item.Manifest.ID)
	}
	return result
}

func sameIDs(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	index := make(map[string]struct{}, len(want))
	for _, id := range want {
		index[id] = struct{}{}
	}
	for _, id := range got {
		if _, ok := index[id]; !ok {
			return false
		}
	}
	return true
}
