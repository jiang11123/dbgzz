package plugins

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func newManagedRuntime(t *testing.T) (*Runtime, *memoryStore, string) {
	t.Helper()
	dataDir := t.TempDir()
	store := &memoryStore{}
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	return runtime, store, dataDir
}

func TestUploadedManifestCannotClaimUserActivationScope(t *testing.T) {
	policy := Management(PromptOptimizer, OriginUploaded)
	if policy.Origin != OriginUploaded || policy.ActivationScope != ScopeSystem || policy.ConfigurationScope != ConfigurationSystem {
		t.Fatalf("uploaded plugin policy = %#v", policy)
	}
}

func TestArtCritiqueIsUserToggleableApplication(t *testing.T) {
	policy := Management(AIArtCritique, "bundled")
	if policy.Origin != OriginOfficial || policy.Kind != KindApplication || policy.ActivationScope != ScopeUser || policy.ConfigurationScope != ConfigurationNone {
		t.Fatalf("AI art critique policy = %#v", policy)
	}
}

func TestEditorShellIsUserToggleableApplication(t *testing.T) {
	policy := Management(EditorShell, "bundled")
	if policy.Origin != OriginOfficial || policy.Kind != KindApplication || policy.ActivationScope != ScopeUser || policy.ConfigurationScope != ConfigurationNone {
		t.Fatalf("editor shell policy = %#v", policy)
	}
}

func TestInstallUploadedRejectsReservedApplicationID(t *testing.T) {
	runtime, store, _ := newManagedRuntime(t)
	svc := New(runtime, store)
	_, err := svc.InstallUploaded("admin-1", testPluginPackage(t, testManifest(PromptOptimizer, "1.0.0")), "prompt-optimizer.beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "由官方应用保留") {
		t.Fatalf("reserved id error = %v", err)
	}
}

func TestEditorShellReportsPlatformAvailableWithoutPlatformState(t *testing.T) {
	runtime, store, _ := newManagedRuntime(t)
	svc := New(runtime, store)
	user := &model.User{ID: "user-1", Role: model.UserRoleUser}
	states, err := svc.StatesForUser(user)
	if err != nil {
		t.Fatal(err)
	}
	state, ok := states[EditorShell]
	if !ok {
		t.Fatalf("editor shell missing from plugin states: %#v", states)
	}
	if !state.PlatformAvailable || !state.CanToggle {
		t.Fatalf("editor shell should be a user-toggleable application, got %#v", state)
	}
	if state.BlockedReason == "管理员已停用该插件" {
		t.Fatalf("editor shell reported as admin-disabled: %#v", state)
	}
}

func TestApplicationPluginUsesUserStateUnderPlatformAvailability(t *testing.T) {
	runtime, store, _ := newManagedRuntime(t)
	svc := New(runtime, store)
	user := &model.User{ID: "user-1", Role: model.UserRoleUser}
	admin := &model.User{ID: "admin-1", Role: model.UserRoleAdmin}

	states, err := svc.StatesForUser(user)
	if err != nil {
		t.Fatal(err)
	}
	initial := states[WorkflowRunningHub]
	if !initial.PlatformAvailable || initial.UserEnabled || initial.EffectiveEnabled || !initial.CanToggle {
		t.Fatalf("initial RunningHub state = %#v", initial)
	}

	enabled, err := svc.SetUserEnabled(user, WorkflowRunningHub, true)
	if err != nil {
		t.Fatal(err)
	}
	if !enabled.UserConfigured || !enabled.UserEnabled || !enabled.EffectiveEnabled {
		t.Fatalf("enabled RunningHub state = %#v", enabled)
	}
	if _, _, err := svc.SetPlatformAvailability(admin, WorkflowRunningHub, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.RequireWorkflowForUser(user.ID, "runninghub-workflow-image"); err == nil {
		t.Fatal("platform-disabled workflow was accepted for a new user request")
	}
	if _, _, err := svc.SetPlatformAvailability(admin, WorkflowRunningHub, true); err != nil {
		t.Fatal(err)
	}
	if err := svc.RequireWorkflowForUser(user.ID, "runninghub-workflow-video"); err != nil {
		t.Fatalf("restored user workflow rejected: %v", err)
	}
}

func TestInstallUploadedRollsBackNewPluginWhenStoreFails(t *testing.T) {
	runtime, store, _ := newManagedRuntime(t)
	store.failSavePlatform = true
	svc := New(runtime, store)
	_, err := svc.InstallUploaded("admin-1", testPluginPackage(t, testManifest("store-fail-upload", "1.0.0")), "store-fail-upload.beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "保存插件平台状态") {
		t.Fatalf("store failure error = %v", err)
	}
	if _, ok := ByID(runtime.List(), "store-fail-upload"); ok {
		t.Fatal("failed uploaded install left the plugin installed")
	}
}

func TestInstallUploadedNilStoreDoesNotInstall(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, nil)
	_, err = svc.InstallUploaded("admin-1", testPluginPackage(t, testManifest("nil-store-upload", "1.0.0")), "nil-store-upload.beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "插件状态存储未初始化") {
		t.Fatalf("nil store error = %v", err)
	}
	if _, ok := ByID(runtime.List(), "nil-store-upload"); ok {
		t.Fatal("nil store installed a plugin")
	}
}

func TestInstallUploadedReplacementKeepsOldVersionWhenStoreFails(t *testing.T) {
	runtime, store, dataDir := newManagedRuntime(t)
	svc := New(runtime, store)
	v1 := testPluginPackage(t, testManifest("replace-store-fail", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", v1, "replace-v1.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	store.failSavePlatform = true
	v2 := testPluginPackage(t, testManifest("replace-store-fail", "2.0.0"))
	_, err := svc.InstallUploaded("admin-1", v2, "replace-v2.beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "保存插件平台状态") {
		t.Fatalf("replacement store error = %v", err)
	}
	item, ok := ByID(runtime.List(), "replace-store-fail")
	if !ok || item.Manifest.Version != "1.0.0" {
		t.Fatalf("replacement rollback = %#v", item)
	}
	assertPackageBytes(t, runtime, dataDir, "replace-store-fail", v1)
	assertBlobExists(t, runtime, v1, true)
	assertBlobExists(t, runtime, v2, false)
}

func TestInstallUploadedCommitThenSkippedPublishRestartsFromStore(t *testing.T) {
	runtime, store, dataDir := newManagedRuntime(t)
	svc := New(runtime, store)
	v1 := testPluginPackage(t, testManifest("replace-skip-publish", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", v1, "replace-skip-publish-v1.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime.skipNextPublish()
	v2 := testPluginPackage(t, testManifest("replace-skip-publish", "2.0.0"))
	_, err := svc.InstallUploaded("admin-1", v2, "replace-skip-publish-v2.beeftv-plugin")
	if err == nil || !errors.Is(err, errPublishInterrupted) {
		t.Fatalf("skip publish error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "replace-skip-publish", "1.0.0", StatusEnabled, v1)
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	assertImmediatePlugin(t, restarted, "replace-skip-publish", "2.0.0", StatusEnabled, v2)
}

func TestInstallUploadedConcurrentStoreFailureDoesNotDropOtherUpdate(t *testing.T) {
	runtime, store, dataDir := newManagedRuntime(t)
	seed := New(runtime, store)
	v1 := testPluginPackage(t, testManifest("concurrent-upload", "1.0.0"))
	if _, err := seed.InstallUploaded("admin-1", v1, "concurrent-v1.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	store.saveCount = 0
	store.failSaveAt = 1
	store.saveStarted = make(chan struct{})
	store.blockSave = make(chan struct{})
	unblock := sync.OnceFunc(func() { close(store.blockSave) })
	t.Cleanup(unblock)
	var enters atomic.Int32
	secondEntered := make(chan struct{})
	runtime.testBeforeMutation = func() {
		if enters.Add(1) == 2 {
			close(secondEntered)
		}
	}
	svcA := New(runtime, store)
	svcB := New(runtime, store)
	v2 := testPluginPackage(t, testManifest("concurrent-upload", "2.0.0"))
	v3 := testPluginPackage(t, testManifest("concurrent-upload", "3.0.0"))
	errA := make(chan error, 1)
	errB := make(chan error, 1)
	go func() {
		_, err := svcA.InstallUploaded("admin-1", v2, "concurrent-v2.beeftv-plugin")
		errA <- err
	}()
	select {
	case <-store.saveStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("first save did not start")
	}
	go func() {
		_, err := svcB.InstallUploaded("admin-1", v3, "concurrent-v3.beeftv-plugin")
		errB <- err
	}()
	select {
	case <-secondEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("second service did not enter mutation")
	}
	unblock()
	if err := <-errA; err == nil || !strings.Contains(err.Error(), "保存插件平台状态") {
		t.Fatalf("first install error = %v", err)
	}
	if err := <-errB; err != nil {
		t.Fatalf("second install error = %v", err)
	}
	item, ok := ByID(runtime.List(), "concurrent-upload")
	if !ok || item.Manifest.Version != "3.0.0" {
		t.Fatalf("concurrent result = %#v", item)
	}
	assertPackageBytes(t, runtime, dataDir, "concurrent-upload", v3)
}

func TestSetPlatformAvailabilityNilStoreDoesNotChangeRuntime(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var officialID string
	for _, item := range runtime.List() {
		if item.Source == OriginOfficial && item.Status == StatusEnabled && Management(item.Manifest.ID, item.Source).ActivationScope == ScopeSystem {
			officialID = item.Manifest.ID
			break
		}
	}
	if officialID == "" {
		t.Fatal("no system-scoped official plugin")
	}
	nilSvc := New(runtime, nil)
	_, _, err = nilSvc.SetPlatformAvailability(&model.User{ID: "admin-1"}, officialID, false)
	if err == nil || !strings.Contains(err.Error(), "插件状态存储未初始化") {
		t.Fatalf("nil store error = %v", err)
	}
	item, ok := ByID(runtime.List(), officialID)
	if !ok || item.Status != StatusEnabled {
		t.Fatalf("nil store mutated runtime = %#v", item)
	}
}

func TestSetPlatformAvailabilityRollsBackRuntimeWhenStoreFails(t *testing.T) {
	runtime, store, _ := newManagedRuntime(t)
	svc := New(runtime, store)
	if _, err := svc.InstallUploaded("admin-1", testPluginPackage(t, testManifest("avail-store-fail", "1.0.0")), "avail-store-fail.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	store.failSavePlatform = true
	_, _, err := svc.SetPlatformAvailability(&model.User{ID: "admin-1"}, "avail-store-fail", false)
	if err == nil || !strings.Contains(err.Error(), "保存插件平台状态") {
		t.Fatalf("availability store error = %v", err)
	}
	item, ok := ByID(runtime.List(), "avail-store-fail")
	if !ok || item.Status != StatusEnabled {
		t.Fatalf("availability rollback = %#v", item)
	}
}

func TestSetPlatformAvailabilityCommitThenSkippedPublishRestartsFromStore(t *testing.T) {
	runtime, store, dataDir := newManagedRuntime(t)
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("avail-skip-publish", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "avail-skip-publish.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime.skipNextPublish()
	_, _, err := svc.SetPlatformAvailability(&model.User{ID: "admin-1"}, "avail-skip-publish", false)
	if err == nil || !errors.Is(err, errPublishInterrupted) {
		t.Fatalf("availability skip publish error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "avail-skip-publish", "1.0.0", StatusEnabled, pkg)
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(restarted.List(), "avail-skip-publish")
	if !ok || item.Status != StatusDisabled {
		t.Fatalf("restarted availability = %#v", item)
	}
}

func TestSetPlatformAvailabilityConcurrentStoreFailureDoesNotUndoOtherChange(t *testing.T) {
	runtime, store, _ := newManagedRuntime(t)
	seed := New(runtime, store)
	if _, err := seed.InstallUploaded("admin-1", testPluginPackage(t, testManifest("avail-concurrent", "1.0.0")), "avail-concurrent.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	store.saveCount = 0
	store.failSaveAt = 1
	store.saveStarted = make(chan struct{})
	store.blockSave = make(chan struct{})
	unblock := sync.OnceFunc(func() { close(store.blockSave) })
	t.Cleanup(unblock)
	var enters atomic.Int32
	secondEntered := make(chan struct{})
	runtime.testBeforeMutation = func() {
		if enters.Add(1) == 2 {
			close(secondEntered)
		}
	}
	svcA := New(runtime, store)
	svcB := New(runtime, store)
	admin := &model.User{ID: "admin-1"}
	errA := make(chan error, 1)
	errB := make(chan error, 1)
	go func() {
		_, _, err := svcA.SetPlatformAvailability(admin, "avail-concurrent", false)
		errA <- err
	}()
	select {
	case <-store.saveStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("first availability save did not start")
	}
	go func() {
		_, _, err := svcB.SetPlatformAvailability(admin, "avail-concurrent", false)
		errB <- err
	}()
	select {
	case <-secondEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("second availability service did not enter mutation")
	}
	unblock()
	if err := <-errA; err == nil || !strings.Contains(err.Error(), "保存插件平台状态") {
		t.Fatalf("first availability error = %v", err)
	}
	if err := <-errB; err != nil {
		t.Fatalf("second availability error = %v", err)
	}
	item, ok := ByID(runtime.List(), "avail-concurrent")
	if !ok || item.Status != StatusDisabled {
		t.Fatalf("concurrent availability result = %#v", item)
	}
}

func TestUninstallUploadedStoreFailureRestoresPlugin(t *testing.T) {
	runtime, store, dataDir := newManagedRuntime(t)
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("uninstall-store-fail", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "uninstall-store-fail.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserPluginState(&model.UserPluginState{ID: "user-state-1", UserID: "user-1", PluginID: "uninstall-store-fail", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	store.failDeletePlatform = true
	if err := svc.UninstallUploaded("uninstall-store-fail"); err == nil || !strings.Contains(err.Error(), "清理插件状态") {
		t.Fatalf("uninstall store error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "uninstall-store-fail", "1.0.0", StatusEnabled, pkg)
	userState, err := store.UserPluginState("user-1", "uninstall-store-fail")
	if err != nil || userState == nil || !userState.Enabled {
		t.Fatalf("user state rolled back = %#v err=%v", userState, err)
	}
	platformState, err := store.PluginPlatformState("uninstall-store-fail")
	if err != nil || platformState == nil {
		t.Fatalf("platform state rolled back = %#v err=%v", platformState, err)
	}
	assertPackageBytes(t, runtime, dataDir, "uninstall-store-fail", pkg)
}

func TestUninstallUploadedSerializesSetUserEnabled(t *testing.T) {
	runtime, store, _ := newManagedRuntime(t)
	seed := New(runtime, store)
	if _, err := seed.InstallUploaded("admin-1", testPluginPackage(t, testManifest("uninstall-serial", "1.0.0")), "uninstall-serial.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	store.deleteStarted = make(chan struct{})
	store.blockDelete = make(chan struct{})
	unblock := sync.OnceFunc(func() { close(store.blockDelete) })
	t.Cleanup(unblock)
	var enters atomic.Int32
	secondEntered := make(chan struct{})
	runtime.testBeforeMutation = func() {
		if enters.Add(1) == 2 {
			close(secondEntered)
		}
	}
	svcA := New(runtime, store)
	svcB := New(runtime, store)
	user := &model.User{ID: "user-1"}
	errUninstall := make(chan error, 1)
	errEnable := make(chan error, 1)
	go func() {
		errUninstall <- svcA.UninstallUploaded("uninstall-serial")
	}()
	select {
	case <-store.deleteStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("uninstall delete did not start")
	}
	go func() {
		_, err := svcB.SetUserEnabled(user, WorkflowRunningHub, true)
		errEnable <- err
	}()
	select {
	case <-secondEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("SetUserEnabled did not enter mutation")
	}
	state, err := store.UserPluginState(user.ID, WorkflowRunningHub)
	if err != nil {
		t.Fatal(err)
	}
	if state != nil {
		t.Fatal("SetUserEnabled wrote while uninstall held the runtime lock")
	}
	unblock()
	if err := <-errUninstall; err != nil {
		t.Fatalf("uninstall error = %v", err)
	}
	if err := <-errEnable; err != nil {
		t.Fatalf("SetUserEnabled error = %v", err)
	}
	if _, ok := ByID(runtime.List(), "uninstall-serial"); ok {
		t.Fatal("uninstalled plugin still listed")
	}
	enabled, err := store.UserPluginState(user.ID, WorkflowRunningHub)
	if err != nil || enabled == nil || !enabled.Enabled {
		t.Fatalf("serialized user enable = %#v err=%v", enabled, err)
	}
}

type memoryStore struct {
	mu                 sync.Mutex
	platform           map[string]*model.PluginPlatformState
	users              map[string]*model.UserPluginState
	records            []RegistryRecord
	hasRegistry        bool
	failSavePlatform   bool
	failDeletePlatform bool
	failSaveAt         int
	saveCount          int
	saveStarted        chan struct{}
	blockSave          chan struct{}
	beforeSave         func()
	deleteStarted      chan struct{}
	blockDelete        chan struct{}
	beforeDelete       func()
}

func (s *memoryStore) PluginPlatformState(pluginID string) (*model.PluginPlatformState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.platform == nil {
		return nil, nil
	}
	state := s.platform[pluginID]
	if state == nil {
		return nil, nil
	}
	copy := *state
	return &copy, nil
}

func (s *memoryStore) UserPluginState(userID, pluginID string) (*model.UserPluginState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.users == nil {
		return nil, nil
	}
	state := s.users[userID+"\x00"+pluginID]
	if state == nil {
		return nil, nil
	}
	copy := *state
	return &copy, nil
}

func (s *memoryStore) SaveUserPluginState(state *model.UserPluginState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.users == nil {
		s.users = map[string]*model.UserPluginState{}
	}
	copy := *state
	s.users[state.UserID+"\x00"+state.PluginID] = &copy
	return nil
}

func (s *memoryStore) SavePluginPlatformState(state *model.PluginPlatformState) error {
	if s.beforeSave != nil {
		s.beforeSave()
	}
	if s.saveStarted != nil {
		select {
		case <-s.saveStarted:
		default:
			close(s.saveStarted)
		}
	}
	if s.blockSave != nil {
		<-s.blockSave
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saveCount++
	if s.failSavePlatform || (s.failSaveAt != 0 && s.saveCount == s.failSaveAt) {
		return errStoreFailed
	}
	if s.platform == nil {
		s.platform = map[string]*model.PluginPlatformState{}
	}
	copy := *state
	s.platform[state.PluginID] = &copy
	return nil
}

func (s *memoryStore) EnabledPluginUserCounts() (map[string]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	counts := map[string]int64{}
	for _, state := range s.users {
		if state.Enabled {
			counts[state.PluginID]++
		}
	}
	return counts, nil
}

func (s *memoryStore) DeletePluginStates(pluginID string) error {
	return s.CommitPluginRegistry(RegistryCommit{DeletePluginID: pluginID, Records: s.snapshotRecords()})
}

func (s *memoryStore) LoadPluginRegistry() ([]RegistryRecord, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.hasRegistry {
		return nil, false, nil
	}
	return cloneRegistryRecords(s.records), true, nil
}

func (s *memoryStore) CommitPluginRegistry(commit RegistryCommit) error {
	if commit.DeletePluginID != "" {
		return s.commitDelete(commit)
	}
	return s.commitSave(commit)
}

func (s *memoryStore) commitSave(commit RegistryCommit) error {
	if s.beforeSave != nil {
		s.beforeSave()
	}
	if s.saveStarted != nil {
		select {
		case <-s.saveStarted:
		default:
			close(s.saveStarted)
		}
	}
	if s.blockSave != nil {
		<-s.blockSave
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saveCount++
	if s.failSavePlatform || (s.failSaveAt != 0 && s.saveCount == s.failSaveAt) {
		return errStoreFailed
	}
	s.records = cloneRegistryRecords(commit.Records)
	s.hasRegistry = true
	if commit.Platform != nil {
		if s.platform == nil {
			s.platform = map[string]*model.PluginPlatformState{}
		}
		copy := *commit.Platform
		s.platform[commit.Platform.PluginID] = &copy
	}
	return nil
}

func (s *memoryStore) commitDelete(commit RegistryCommit) error {
	if s.beforeDelete != nil {
		s.beforeDelete()
	}
	if s.deleteStarted != nil {
		select {
		case <-s.deleteStarted:
		default:
			close(s.deleteStarted)
		}
	}
	if s.blockDelete != nil {
		<-s.blockDelete
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failDeletePlatform {
		return errStoreFailed
	}
	s.records = cloneRegistryRecords(commit.Records)
	s.hasRegistry = true
	for key, state := range s.users {
		if state.PluginID == commit.DeletePluginID {
			delete(s.users, key)
		}
	}
	delete(s.platform, commit.DeletePluginID)
	return nil
}

func (s *memoryStore) snapshotRecords() []RegistryRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneRegistryRecords(s.records)
}

var errStoreFailed = errString("store failed")

type errString string

func (e errString) Error() string { return string(e) }
