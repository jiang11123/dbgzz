package plugins

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type crashStore struct {
	Store
	mu           sync.Mutex
	failCommit   error
	failNextLoad bool
}

func (s *crashStore) LoadPluginRegistry() ([]RegistryRecord, bool, error) {
	s.mu.Lock()
	fail := s.failNextLoad
	s.failNextLoad = false
	s.mu.Unlock()
	if fail {
		return nil, false, errStoreFailed
	}
	return s.Store.LoadPluginRegistry()
}

func (s *crashStore) CommitPluginRegistry(commit RegistryCommit) error {
	s.mu.Lock()
	fail := s.failCommit
	s.failCommit = nil
	s.mu.Unlock()
	if fail != nil {
		return fail
	}
	return s.Store.CommitPluginRegistry(commit)
}

func newSQLitePluginEnv(t *testing.T) (string, Store, *repository.Repository) {
	t.Helper()
	dataDir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dataDir, "app.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.PluginPlatformState{}, &model.UserPluginState{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	return dataDir, NewRepositoryStore(repo), repo
}

func TestInstallCrashBeforeCommitRestartsFromOldState(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	v1 := testPluginPackage(t, testManifest("crash-install", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", v1, "crash-install-v1.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime.failNextCommit(errors.New("forced pre-commit failure"))
	v2 := testPluginPackage(t, testManifest("crash-install", "2.0.0"))
	_, err = svc.InstallUploaded("admin-1", v2, "crash-install-v2.beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "forced pre-commit failure") {
		t.Fatalf("pre-commit error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "crash-install", "1.0.0", StatusEnabled, v1)
	assertBlobExists(t, runtime, v1, true)
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	assertImmediatePlugin(t, restarted, "crash-install", "1.0.0", StatusEnabled, v1)
}

func TestInstallCrashAfterCommitBeforePublishRestartsFromCommittedState(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	v1 := testPluginPackage(t, testManifest("crash-publish-install", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", v1, "crash-publish-install-v1.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime.skipNextPublish()
	v2 := testPluginPackage(t, testManifest("crash-publish-install", "2.0.0"))
	_, err = svc.InstallUploaded("admin-1", v2, "crash-publish-install-v2.beeftv-plugin")
	if err == nil || !errors.Is(err, errPublishInterrupted) {
		t.Fatalf("post-commit error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "crash-publish-install", "1.0.0", StatusEnabled, v1)
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	assertImmediatePlugin(t, restarted, "crash-publish-install", "2.0.0", StatusEnabled, v2)
}

func TestEnableCrashBeforeAndAfterCommit(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("crash-enable", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "crash-enable.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	admin := &model.User{ID: "admin-1"}
	runtime.failNextCommit(errors.New("forced enable pre-commit"))
	if _, _, err := svc.SetPlatformAvailability(admin, "crash-enable", false); err == nil || !strings.Contains(err.Error(), "forced enable pre-commit") {
		t.Fatalf("enable pre-commit error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "crash-enable", "1.0.0", StatusEnabled, pkg)
	pre, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(pre.List(), "crash-enable")
	if !ok || item.Status != StatusEnabled {
		t.Fatalf("restart after enable pre-commit = %#v", item)
	}

	runtime = pre
	svc = New(runtime, store)
	runtime.skipNextPublish()
	if _, _, err := svc.SetPlatformAvailability(admin, "crash-enable", false); err == nil || !errors.Is(err, errPublishInterrupted) {
		t.Fatalf("enable post-commit error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "crash-enable", "1.0.0", StatusEnabled, pkg)
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	item, ok = ByID(restarted.List(), "crash-enable")
	if !ok || item.Status != StatusDisabled {
		t.Fatalf("restart after enable post-commit = %#v", item)
	}
}

func TestUninstallCrashBeforeAndAfterCommit(t *testing.T) {
	dataDir, store, repo := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("crash-uninstall", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "crash-uninstall.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserPluginState(&model.UserPluginState{ID: "user-state-crash", UserID: "user-1", PluginID: "crash-uninstall", Enabled: true, CreatedAt: time.Now(), UpdatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	runtime.failNextCommit(errors.New("forced uninstall pre-commit"))
	if err := svc.UninstallUploaded("crash-uninstall"); err == nil || !strings.Contains(err.Error(), "forced uninstall pre-commit") {
		t.Fatalf("uninstall pre-commit error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "crash-uninstall", "1.0.0", StatusEnabled, pkg)
	pre, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ByID(pre.List(), "crash-uninstall"); !ok {
		t.Fatal("restart after uninstall pre-commit dropped plugin")
	}
	user, err := repo.UserPluginState("user-1", "crash-uninstall")
	if err != nil || user == nil {
		t.Fatalf("user state after uninstall pre-commit = %#v err=%v", user, err)
	}

	runtime = pre
	svc = New(runtime, store)
	runtime.skipNextPublish()
	if err := svc.UninstallUploaded("crash-uninstall"); err == nil || !errors.Is(err, errPublishInterrupted) {
		t.Fatalf("uninstall post-commit error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "crash-uninstall", "1.0.0", StatusEnabled, pkg)
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ByID(restarted.List(), "crash-uninstall"); ok {
		t.Fatal("restart after uninstall post-commit still lists plugin")
	}
	user, err = repo.UserPluginState("user-1", "crash-uninstall")
	if err != nil || user != nil {
		t.Fatalf("user state after uninstall post-commit = %#v err=%v", user, err)
	}
	platform, err := repo.PluginPlatformState("crash-uninstall")
	if err != nil || platform != nil {
		t.Fatalf("platform state after uninstall post-commit = %#v err=%v", platform, err)
	}
}

func TestInstallTransactionFailureWithFSFailureKeepsReferencedBlob(t *testing.T) {
	dataDir, inner, _ := newSQLitePluginEnv(t)
	store := &crashStore{Store: inner}
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	v1 := testPluginPackage(t, testManifest("tx-fs", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", v1, "tx-fs-v1.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime.testFailCommit = func() error {
		store.mu.Lock()
		store.failNextLoad = true
		store.mu.Unlock()
		return errors.New("forced tx failure")
	}
	v2 := testPluginPackage(t, testManifest("tx-fs", "2.0.0"))
	_, err = svc.InstallUploaded("admin-1", v2, "tx-fs-v2.beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "forced tx failure") {
		t.Fatalf("tx+fs error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "tx-fs", "1.0.0", StatusEnabled, v1)
	assertBlobExists(t, runtime, v1, true)
	assertBlobExists(t, runtime, v2, true)
	restarted, err := NewRuntimeWithStore(dataDir, inner)
	if err != nil {
		t.Fatal(err)
	}
	assertImmediatePlugin(t, restarted, "tx-fs", "1.0.0", StatusEnabled, v1)
	assertBlobExists(t, restarted, v1, true)
}

func TestSameHashReinstallFailureDoesNotDeleteLivePackage(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("same-hash", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "same-hash.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime.failNextCommit(errors.New("forced same-hash commit failure"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "same-hash.beeftv-plugin"); err == nil || !strings.Contains(err.Error(), "forced same-hash commit failure") {
		t.Fatalf("same-hash error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "same-hash", "1.0.0", StatusEnabled, pkg)
	assertBlobExists(t, runtime, pkg, true)
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	assertImmediatePlugin(t, restarted, "same-hash", "1.0.0", StatusEnabled, pkg)
}

func TestLegacyDiskImportThenStaleFileIsIgnored(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	v1 := testPluginPackage(t, testManifest("legacy-import", "1.0.0"))
	fileRuntime, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fileRuntime.Install(v1, "legacy-import.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ByID(runtime.List(), "legacy-import"); !ok {
		t.Fatal("legacy upload was not imported")
	}
	svc := New(runtime, store)
	v2 := testPluginPackage(t, testManifest("legacy-import", "2.0.0"))
	if _, err := svc.InstallUploaded("admin-1", v2, "legacy-import-v2.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	stale, err := json.Marshal([]RegistryRecord{{ID: "stale-only", Raw: json.RawMessage(`{"apiVersion":"beeftv.plugin/v1","id":"stale-only"}`), Source: OriginUploaded}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "plugin_registry.json"), stale, 0o600); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	assertImmediatePlugin(t, restarted, "legacy-import", "2.0.0", StatusEnabled, v2)
	if _, ok := ByID(restarted.List(), "stale-only"); ok {
		t.Fatal("stale disk registry overwrote committed sqlite state")
	}
}

func TestMalformedLegacyImportFailsClosedAndPreservesBytes(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	legacyPath := filepath.Join(dataDir, "plugin_registry.json")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	garbage := []byte("{not-json")
	if err := os.WriteFile(legacyPath, garbage, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRuntimeWithStore(dataDir, store); err == nil || !strings.Contains(err.Error(), "遗留插件 registry") {
		t.Fatalf("malformed import error = %v", err)
	}
	got, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(garbage) {
		t.Fatalf("malformed legacy file was rewritten")
	}
}

func TestMalformedAuthoritativeDBFailsClosedAndIgnoresDisk(t *testing.T) {
	dataDir, store, repo := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("db-corrupt", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "db-corrupt.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	if err := repo.SaveSystemSetting(&model.SystemSetting{Key: RegistrySettingKey, ValueJSON: "{not-json"}); err != nil {
		t.Fatal(err)
	}
	validDisk, err := json.Marshal([]RegistryRecord{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "plugin_registry.json"), validDisk, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRuntimeWithStore(dataDir, store); err == nil || !strings.Contains(err.Error(), "读取插件 registry") {
		t.Fatalf("malformed db error = %v", err)
	}
}

func TestInvalidLegacyImportFailsClosedPreservesBytesAndSkipsAuthority(t *testing.T) {
	cases := []struct {
		name string
		body []byte
	}{
		{name: "duplicate-id", body: marshalRegistryForTest(t, []RegistryRecord{
			{ID: "dup-id", Raw: testManifest("dup-id", "1.0.0"), Source: OriginUploaded},
			{ID: "dup-id", Raw: testManifest("dup-id", "2.0.0"), Source: OriginUploaded},
		})},
		{name: "id-mismatch", body: marshalRegistryForTest(t, []RegistryRecord{
			{ID: "alpha", Raw: testManifest("beta", "1.0.0"), Source: OriginUploaded},
		})},
		{name: "malformed-manifest", body: marshalRegistryForTest(t, []RegistryRecord{
			{ID: "bad-json", Raw: json.RawMessage(`{"id":1}`), Source: OriginUploaded},
		})},
		{name: "path-escape", body: marshalRegistryForTest(t, []RegistryRecord{
			{ID: "path-escape", Raw: testManifest("path-escape", "1.0.0"), Source: OriginUploaded, PackagePath: "../evil.beeftv-plugin", PackageSHA256: strings.Repeat("ab", 32)},
		})},
		{name: "path-hash-mismatch", body: marshalRegistryForTest(t, []RegistryRecord{
			{ID: "path-hash", Raw: testManifest("path-hash", "1.0.0"), Source: OriginUploaded, PackagePath: strings.Repeat("ab", 32) + protocol.PluginPackageExtension, PackageSHA256: strings.Repeat("cd", 32)},
		})},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dataDir, store, repo := newSQLitePluginEnv(t)
			legacyPath := filepath.Join(dataDir, "plugin_registry.json")
			if err := os.WriteFile(legacyPath, tc.body, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := NewRuntimeWithStore(dataDir, store); err == nil || !strings.Contains(err.Error(), "遗留插件 registry") {
				t.Fatalf("invalid legacy error = %v", err)
			}
			got, err := os.ReadFile(legacyPath)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, tc.body) {
				t.Fatalf("legacy bytes rewritten:\n got %s\nwant %s", got, tc.body)
			}
			assertNoAuthorityRow(t, repo)
		})
	}
}

func TestInvalidAuthoritativeDBFailsClosedAndPreservesBytes(t *testing.T) {
	dataDir, store, repo := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("db-struct", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "db-struct.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	var officialID string
	for _, item := range runtime.List() {
		if item.Source == OriginOfficial && strings.HasSuffix(item.FileName, protocol.PluginPackageExtension) {
			officialID = item.Manifest.ID
			break
		}
	}
	if officialID == "" {
		t.Fatal("no official packaged plugin; run plugin-packages/build-packages.sh")
	}
	cases := []struct {
		name string
		body []byte
	}{
		{name: "duplicate-id", body: marshalRegistryForTest(t, []RegistryRecord{
			{ID: "dup-db", Raw: testManifest("dup-db", "1.0.0"), Source: OriginUploaded},
			{ID: "dup-db", Raw: testManifest("dup-db", "2.0.0"), Source: OriginUploaded},
		})},
		{name: "id-mismatch", body: marshalRegistryForTest(t, []RegistryRecord{
			{ID: officialID, Raw: testManifest("not-"+officialID, "9.0.0"), Source: OriginOfficial},
		})},
		{name: "malformed-manifest", body: marshalRegistryForTest(t, []RegistryRecord{
			{ID: "bad-db", Raw: json.RawMessage(`{"id":1}`), Source: OriginUploaded},
		})},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := repo.SaveSystemSetting(&model.SystemSetting{Key: RegistrySettingKey, ValueJSON: string(tc.body)}); err != nil {
				t.Fatal(err)
			}
			if _, err := NewRuntimeWithStore(dataDir, store); err == nil || !strings.Contains(err.Error(), "读取插件 registry") {
				t.Fatalf("invalid db error = %v", err)
			}
			assertAuthorityBytes(t, repo, tc.body)
		})
	}
}

func TestUnavailableAdapterStartsAndKeepsStructurallyValidAuthority(t *testing.T) {
	dataDir, store, repo := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("host-missing", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "host-missing.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	records, found, err := store.LoadPluginRegistry()
	if err != nil || !found {
		t.Fatalf("load registry found=%v err=%v", found, err)
	}
	replaced := false
	for index := range records {
		if records[index].ID == "host-missing" {
			records[index].Raw = hostUnavailableManifest("host-missing")
			replaced = true
		}
	}
	if !replaced {
		t.Fatal("uploaded record missing from authority")
	}
	body := marshalRegistryForTest(t, records)
	if err := repo.SaveSystemSetting(&model.SystemSetting{Key: RegistrySettingKey, ValueJSON: string(body)}); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatalf("unavailable adapter should start: %v", err)
	}
	item, ok := ByID(restarted.List(), "host-missing")
	if !ok || item.Status != StatusInvalid || item.Error == "" {
		t.Fatalf("unavailable plugin = %#v ok=%v", item, ok)
	}
	if restarted.Registry().IsCapability("host-missing", protocol.CapabilityVideo) {
		t.Fatal("unavailable adapter was selectable")
	}
}

func TestSameHashInstallReusesVerifiedBlob(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("reuse-blob", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "reuse-blob.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(runtime.packageDir, blobFileName(pluginHash(pkg)))
	stale := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(path, stale, stale); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.InstallUploaded("admin-1", pkg, "reuse-blob.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("verified same-hash blob was rewritten")
	}
	assertImmediatePlugin(t, runtime, "reuse-blob", "1.0.0", StatusEnabled, pkg)
}

func TestSameHashInstallDoesNotRewriteCorruptExistingBlob(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("corrupt-blob", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "corrupt-blob.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(runtime.packageDir, blobFileName(pluginHash(pkg)))
	garbage := []byte("not-the-registered-plugin")
	if err := os.WriteFile(path, garbage, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.InstallUploaded("admin-1", pkg, "corrupt-blob.beeftv-plugin"); err == nil || !strings.Contains(err.Error(), "内容与哈希不一致") {
		t.Fatalf("corrupt blob reinstall error = %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, garbage) {
		t.Fatal("corrupt blob was rewritten")
	}
	item, ok := ByID(runtime.List(), "corrupt-blob")
	if !ok || item.Manifest.Version != "1.0.0" || item.Status != StatusEnabled {
		t.Fatalf("live plugin after failed reinstall = %#v ok=%v", item, ok)
	}
}

func TestPackageRejectsCorruptBlob(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("export-corrupt", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "export-corrupt.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(runtime.packageDir, blobFileName(pluginHash(pkg)))
	if err := os.WriteFile(path, []byte("corrupt-export"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, name, err := runtime.Package("export-corrupt")
	if err == nil || data != nil || name != "" {
		t.Fatalf("exported untrusted package name=%q err=%v", name, err)
	}
	if !strings.Contains(err.Error(), "哈希不一致") {
		t.Fatalf("corrupt export error = %v", err)
	}
	item, ok := ByID(runtime.List(), "export-corrupt")
	if !ok || item.Status != StatusEnabled {
		t.Fatalf("execution still uses Raw; list = %#v ok=%v", item, ok)
	}
}

func TestPackageSerializesWithUninstall(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("export-race", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "export-race.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	wantHash := pluginHash(pkg)
	var start sync.WaitGroup
	var work sync.WaitGroup
	start.Add(1)
	errorsCh := make(chan error, 16)
	for i := 0; i < 8; i++ {
		work.Add(1)
		go func() {
			defer work.Done()
			start.Wait()
			data, _, err := runtime.Package("export-race")
			if err != nil {
				return
			}
			if pluginHash(data) != wantHash {
				errorsCh <- fmt.Errorf("exported untrusted package bytes")
			}
		}()
	}
	work.Add(1)
	go func() {
		defer work.Done()
		start.Wait()
		if err := svc.UninstallUploaded("export-race"); err != nil {
			errorsCh <- err
		}
	}()
	start.Done()
	work.Wait()
	close(errorsCh)
	for err := range errorsCh {
		t.Fatal(err)
	}
}

func marshalRegistryForTest(t *testing.T, records []RegistryRecord) []byte {
	t.Helper()
	data, err := json.Marshal(records)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func hostUnavailableManifest(id string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"apiVersion":"beeftv.plugin/v1","id":%q,"version":"1.0.0","name":%q,"author":"Test","documentation":"# %s","runtime":{"backend":"host:missing-engine"},"contributes":{"providers":[{"id":%q,"label":%q,"capabilities":["video"],"scopes":["canvas"],"create":{"method":"POST","path":"/tasks","fields":{"prompt":"request.prompt"}},"response":{"statusPaths":["status"]}}]}}`, id, id, id, id, id))
}

func assertNoAuthorityRow(t *testing.T, repo *repository.Repository) {
	t.Helper()
	setting, err := repo.LookupSystemSetting(RegistrySettingKey)
	if err != nil {
		t.Fatal(err)
	}
	if setting != nil {
		t.Fatalf("authority row written: %q", setting.ValueJSON)
	}
}

func assertAuthorityBytes(t *testing.T, repo *repository.Repository, want []byte) {
	t.Helper()
	setting, err := repo.LookupSystemSetting(RegistrySettingKey)
	if err != nil {
		t.Fatal(err)
	}
	if setting == nil {
		t.Fatal("authority row missing")
	}
	if setting.ValueJSON != string(want) {
		t.Fatalf("authority bytes changed:\n got %s\nwant %s", setting.ValueJSON, want)
	}
}
