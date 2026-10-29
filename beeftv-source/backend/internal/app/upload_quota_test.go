package app

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
)

func TestReserveUserUploadQuotaRejectsSingleFileAtLimit(t *testing.T) {
	svc := newResourceTestService(t)
	_, err := svc.reserveUserUploadQuota("user-1", megabytes(defaultRuntimePolicy().Resource.ResourceUploadMB))
	if err == nil || !strings.Contains(err.Error(), "小于 50MB") {
		t.Fatalf("reserveUserUploadQuota() error = %v", err)
	}
}

func TestReserveUserUploadQuotaRejectsDailyTotalAtLimit(t *testing.T) {
	svc := newResourceTestService(t)
	daily := megabytes(defaultRuntimePolicy().Resource.DailyUploadMB)
	chunk := int64(49 << 20)
	for used := int64(0); used+chunk <= daily; used += chunk {
		if _, err := svc.reserveUserUploadQuota("user-1", chunk); err != nil {
			t.Fatal(err)
		}
	}
	// 单文件限(50MB)未命中、今日额度已满 → 拒绝并提示每日上限。
	if _, err := svc.reserveUserUploadQuota("user-1", chunk); err == nil || !strings.Contains(err.Error(), "小于 2GB") {
		t.Fatalf("reserveUserUploadQuota() error = %v", err)
	}
}

func TestReleaseUserUploadQuotaRestoresCapacity(t *testing.T) {
	svc := newResourceTestService(t)
	day, err := svc.reserveUserUploadQuota("user-1", 49<<20)
	if err != nil {
		t.Fatal(err)
	}
	svc.releaseUserUploadQuota("user-1", day, 49<<20)
	if _, err := svc.reserveUserUploadQuota("user-1", 49<<20); err != nil {
		t.Fatal(err)
	}
}

func TestCommitUserUploadQuotaKeepsDailyUsageWithoutPendingStorage(t *testing.T) {
	svc := newResourceTestService(t)
	day, err := svc.reserveUserUploadQuota("user-1", 49<<20)
	if err != nil {
		t.Fatal(err)
	}
	svc.commitUserUploadQuota("user-1", 49<<20)
	if svc.pendingStorage[pendingStorageKey("user-1", "")] != 0 {
		t.Fatalf("pending storage = %d", svc.pendingStorage[pendingStorageKey("user-1", "")])
	}
	usage, err := svc.repo.DailyUploadBytes("user-1", day)
	if err != nil {
		t.Fatal(err)
	}
	if usage != 49<<20 {
		t.Fatalf("daily usage = %d", usage)
	}
}

func TestReserveUserUploadQuotaRejectsTotalStoredFilesAtLimit(t *testing.T) {
	svc := newResourceTestService(t)
	if err := svc.repo.Create(&model.Resource{ID: "resource-1", UserID: "user-1", Status: model.ResourceStatusReady, Size: gigabytes(defaultRuntimePolicy().Resource.StoredFileGB) - 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.reserveUserUploadQuota("user-1", 1); err == nil || !strings.Contains(err.Error(), "20GB 上限") {
	}
}

func TestReserveGeneratedResourceQuotaAllowsUploadLimitAndRejectsGeneratedCap(t *testing.T) {
	svc := newResourceTestService(t)
	uploadLimit := megabytes(defaultRuntimePolicy().Resource.ResourceUploadMB)
	generatedLimit := megabytes(defaultRuntimePolicy().Resource.GeneratedFileMB)
	if _, err := svc.reserveUserUploadQuota("user-1", uploadLimit); err == nil || !strings.Contains(err.Error(), "小于 50MB") {
		t.Fatalf("upload at ResourceUploadMB error = %v", err)
	}
	if _, err := svc.reserveGeneratedResourceQuota("user-1", uploadLimit); err != nil {
		t.Fatalf("generated at ResourceUploadMB = %v", err)
	}
	if _, err := svc.reserveGeneratedResourceQuota("user-2", generatedLimit); err != nil {
		t.Fatalf("generated at GeneratedFileMB = %v", err)
	}
	if _, err := svc.reserveGeneratedResourceQuota("user-3", generatedLimit+1); err == nil || !strings.Contains(err.Error(), "不能超过 64MB") {
		t.Fatalf("generated above GeneratedFileMB error = %v", err)
	}
}

func TestReserveRetryGeneratedQuotaUsesGeneratedFileLimit(t *testing.T) {
	svc := newResourceTestService(t)
	uploadLimit := megabytes(defaultRuntimePolicy().Resource.ResourceUploadMB)
	generatedLimit := megabytes(defaultRuntimePolicy().Resource.GeneratedFileMB)
	if _, err := svc.reserveRetryUploadQuota("user-1", uploadLimit); err == nil || !strings.Contains(err.Error(), "小于 50MB") {
		t.Fatalf("retry upload at ResourceUploadMB error = %v", err)
	}
	if _, err := svc.reserveRetryGeneratedQuota("user-1", uploadLimit); err != nil {
		t.Fatalf("retry generated at ResourceUploadMB = %v", err)
	}
	if _, err := svc.reserveRetryGeneratedQuota("user-2", generatedLimit); err != nil {
		t.Fatalf("retry generated at GeneratedFileMB = %v", err)
	}
	if _, err := svc.reserveRetryGeneratedQuota("user-3", generatedLimit+1); err == nil || !strings.Contains(err.Error(), "不能超过 64MB") {
		t.Fatalf("retry generated above GeneratedFileMB error = %v", err)
	}
}

func TestAccountFileStorageUsageUsesStoredFilePolicy(t *testing.T) {
	svc := newResourceTestService(t)
	if err := svc.repo.Create(&model.Resource{ID: "resource-1", UserID: "user-1", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "ready.png", Size: 3 << 20}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.Create(&model.Resource{ID: "resource-duplicate", UserID: "user-1", Status: model.ResourceStatusReady, Provider: "", ObjectKey: "ready.png", Size: 3 << 20}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.Create(&model.Resource{ID: "resource-failed", UserID: "user-1", Status: model.ResourceStatusFailed, Provider: "local", ObjectKey: "failed.png", Size: 7 << 20}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.Create(&model.Resource{ID: "resource-pending", UserID: "user-1", Status: model.ResourceStatusPending, Provider: "local", ObjectKey: "pending.png", Size: 11 << 20}); err != nil {
		t.Fatal(err)
	}
	usage, err := svc.AccountFileStorageUsage("user-1")
	if err != nil {
		t.Fatal(err)
	}
	if usage.UsedBytes != 3<<20 || usage.TotalBytes != gigabytes(defaultRuntimePolicy().Resource.StoredFileGB) {
		t.Fatalf("AccountFileStorageUsage() = %#v", usage)
	}
}

func TestCommitIdentifiedQuotaLeavesOtherPending(t *testing.T) {
	svc := newResourceTestService(t)
	ordinary := int64(49 << 20)
	if _, err := svc.reserveUserUploadQuotaFor("user-1", ordinary, "ordinary-upload"); err != nil {
		t.Fatal(err)
	}
	svc.commitUserUploadQuotaFor("user-1", 7, "generated-orphan")
	if got := svc.pendingStorage[pendingStorageKey("user-1", "ordinary-upload")]; got != ordinary {
		t.Fatalf("ordinary pending = %d", got)
	}
	if _, ok := svc.pendingStorage[pendingStorageKey("user-1", "generated-orphan")]; ok {
		t.Fatal("missing identity created a pending entry")
	}
}

func TestRetryReservationDoesNotConsumeUploadPending(t *testing.T) {
	svc := newResourceTestService(t)
	ordinary := int64(49 << 20)
	if _, err := svc.reserveUserUploadQuotaFor("user-1", ordinary, "ordinary-upload"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.reserveRetryGeneratedQuotaFor("user-1", 7, "generated-retry"); err != nil {
		t.Fatal(err)
	}
	if got := svc.pendingStorage[pendingStorageKey("user-1", "ordinary-upload")]; got != ordinary {
		t.Fatalf("ordinary pending = %d", got)
	}
	if _, ok := svc.pendingStorage[pendingStorageKey("user-1", "generated-retry")]; ok {
		t.Fatal("retry-only reservation wrote pending storage")
	}
}

func TestPromoteReadyDoesNotDebitOrdinaryUploadPending(t *testing.T) {
	svc := newResourceTestService(t)
	identity := "task-orphan:0"
	uploadKey := localasset.NormalizedUploadKey([]string{identity})
	resource := model.Resource{
		ID: "res-orphan", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/orphan.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := svc.repo.Create(&resource); err != nil {
		t.Fatal(err)
	}
	if err := localasset.NewFileStore(svc.dataDir).Write(resource.ObjectKey, bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}
	ordinary := int64(49 << 20)
	if _, err := svc.reserveUserUploadQuotaFor("user-1", ordinary, "ordinary-upload"); err != nil {
		t.Fatal(err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	if err := svc.repo.ReserveIdentifiedDailyUpload("user-1", day, *uploadKey, resource.Size, megabytes(defaultRuntimePolicy().Resource.DailyUploadMB)); err != nil {
		t.Fatal(err)
	}
	usageBefore, err := svc.repo.DailyUploadBytes("user-1", day)
	if err != nil {
		t.Fatal(err)
	}
	var promoteErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, promoteErr = svc.resourceDomain().RecoverOwned("user-1", identity, func() (localasset.RecoveredArtifact, error) {
			return localasset.RecoveredArtifact{}, errors.New("leftover bytes called restore")
		})
	}()
	wg.Wait()
	if promoteErr != nil {
		t.Fatal(promoteErr)
	}
	if got := svc.pendingStorage[pendingStorageKey("user-1", "ordinary-upload")]; got != ordinary {
		t.Fatalf("ordinary pending = %d", got)
	}
	usageAfter, err := svc.repo.DailyUploadBytes("user-1", day)
	if err != nil {
		t.Fatal(err)
	}
	if usageAfter != usageBefore {
		t.Fatalf("daily changed from %d to %d", usageBefore, usageAfter)
	}
}

func TestUnkeyedGeneratedOperationsUseIndependentPending(t *testing.T) {
	svc := newResourceTestService(t)
	first, err := svc.resourceDomain().StoreGenerated("user-1", "image", "a.png", "image/png", 7, 1, 1, 0, bytes.NewReader([]byte("payload")))
	if err != nil || first == nil {
		t.Fatalf("first generated = %#v err=%v", first, err)
	}
	ordinary := int64(49 << 20)
	if _, err := svc.reserveUserUploadQuotaFor("user-1", ordinary, "ordinary-upload"); err != nil {
		t.Fatal(err)
	}
	second, err := svc.resourceDomain().StoreGenerated("user-1", "image", "b.png", "image/png", 5, 1, 1, 0, bytes.NewReader([]byte("other")))
	if err != nil || second == nil || second.ID == first.ID {
		t.Fatalf("second generated = %#v err=%v", second, err)
	}
	if got := svc.pendingStorage[pendingStorageKey("user-1", "ordinary-upload")]; got != ordinary {
		t.Fatalf("ordinary pending = %d", got)
	}
}

func TestChunkedUploadStartUsesCanonicalQuota(t *testing.T) {
	svc := newResourceTestService(t)
	ordinary := int64(49 << 20)
	if _, err := svc.reserveUserUploadQuotaFor("user-1", ordinary, "ordinary-upload"); err != nil {
		t.Fatal(err)
	}
	session, err := svc.StartChunkedResourceUpload("user-1", localasset.ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 7})
	if err != nil {
		t.Fatal(err)
	}
	if session.UploadID == "" || session.ChunkSize != localasset.ChunkUploadSize || session.ChunkCount != 1 {
		t.Fatalf("session = %#v", session)
	}
	if got := svc.pendingStorage[pendingStorageKey("user-1", "ordinary-upload")]; got != ordinary {
		t.Fatalf("ordinary pending = %d", got)
	}
	if got := svc.pendingStorage[pendingStorageKey("user-1", session.UploadID)]; got != 7 {
		t.Fatalf("session pending = %d", got)
	}
}

func TestChunkedUploadCrashBeforeMetaReleasesDailyViaReservationWitness(t *testing.T) {
	svc := newResourceTestService(t)
	session, err := svc.StartChunkedResourceUpload("user-1", localasset.ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 7})
	if err != nil {
		t.Fatal(err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	usage, err := svc.repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("start daily=%d err=%v", usage, err)
	}
	root := filepath.Join(svc.dataDir, "chunk-sessions")
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) == 0 {
		t.Fatalf("session dir missing: %v %v", entries, err)
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	restarted := &Service{repo: svc.repo, dataDir: svc.dataDir}
	if restarted.resourceDomain() == nil {
		t.Fatal("restart domain is nil")
	}
	usage, err = restarted.repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 0 {
		t.Fatalf("crash-before-meta leaked daily=%d err=%v session=%s", usage, err, session.UploadID)
	}
	row, err := restarted.repo.UploadReservation("user-1", session.UploadID)
	if err != nil || row != nil {
		t.Fatalf("reservation witness leftover %#v err=%v", row, err)
	}
}

func TestChunkedUploadRecoveryReleasesIdentityOnlyOnce(t *testing.T) {
	svc := newResourceTestService(t)
	day := time.Now().UTC().Format("2006-01-02")
	if err := svc.repo.ReserveDailyUpload("user-1", day, 100, 1000); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.StartChunkedResourceUpload("user-1", localasset.ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 7}); err != nil {
		t.Fatal(err)
	}
	// Both the quota reservation and reserved meta.json survive the crash.
	for range 2 {
		restarted := &Service{repo: svc.repo, dataDir: svc.dataDir}
		restarted.resourceDomain()
		usage, err := svc.repo.DailyUploadBytes("user-1", day)
		if err != nil || usage != 100 {
			t.Fatalf("recovery changed other uploads: bytes=%d err=%v", usage, err)
		}
	}
}

func TestChunkedUploadCompleteCommitsCanonicalQuota(t *testing.T) {
	svc := newResourceTestService(t)
	body := []byte("payload")
	session, err := svc.StartChunkedResourceUpload("user-1", localasset.ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.PutChunkedResourceUpload("user-1", session.UploadID, 0, bytes.NewReader(body)); err != nil {
		t.Fatal(err)
	}
	resource, err := svc.CompleteChunkedResourceUpload("user-1", session.UploadID)
	if err != nil || resource == nil || resource.Status != model.ResourceStatusReady {
		t.Fatalf("complete = %#v err=%v", resource, err)
	}
	if got := svc.pendingStorage[pendingStorageKey("user-1", session.UploadID)]; got != 0 {
		t.Fatalf("pending leftover after complete = %d", got)
	}
	day := time.Now().UTC().Format("2006-01-02")
	usage, err := svc.repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != int64(len(body)) {
		t.Fatalf("committed daily=%d err=%v", usage, err)
	}
	row, err := svc.repo.UploadReservation("user-1", session.UploadID)
	if err != nil || row != nil {
		t.Fatalf("reservation witness after commit %#v err=%v", row, err)
	}
}

func TestLeftoverReadyRestartDeleteKeepsConsumedDaily(t *testing.T) {
	svc := newResourceTestService(t)
	resource, err := svc.UploadResourceFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "ready-left")
	if err != nil || resource == nil {
		t.Fatalf("upload = %#v err=%v", resource, err)
	}
	identity := *localasset.NormalizedUploadKey([]string{"ready-left"})
	day := time.Now().UTC().Format("2006-01-02")
	cleared, err := svc.repo.UploadReservation("user-1", identity)
	if err != nil || cleared != nil {
		t.Fatalf("READY save left witness %#v err=%v", cleared, err)
	}
	now := time.Now()
	if err := svc.repo.DB().Create(&model.UserUploadReservation{
		ID: "user-1:" + identity, UserID: "user-1", Identity: identity, Day: day, Size: 7,
		CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	restarted := &Service{repo: svc.repo, dataDir: svc.dataDir}
	if restarted.resourceDomain() == nil {
		t.Fatal("restart domain is nil")
	}
	usage, err := restarted.repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("READY leftover daily=%d err=%v", usage, err)
	}
	row, err := restarted.repo.UploadReservation("user-1", identity)
	if err != nil || row != nil {
		t.Fatalf("READY leftover witness %#v err=%v", row, err)
	}

	if err := restarted.repo.DeleteResource("user-1", resource.ID); err != nil {
		t.Fatal(err)
	}
	again := &Service{repo: svc.repo, dataDir: svc.dataDir}
	again.resourceDomain()
	usage, err = again.repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("delete then restart refunded daily=%d err=%v", usage, err)
	}
}

func TestLeftoverFailedRestartAllowsRetry(t *testing.T) {
	svc := newResourceTestService(t)
	identity := *localasset.NormalizedUploadKey([]string{"failed-left"})
	day := time.Now().UTC().Format("2006-01-02")
	if err := svc.repo.ReserveIdentifiedDailyUpload("user-1", day, identity, 7, 1<<40); err != nil {
		t.Fatal(err)
	}
	failed := &model.Resource{
		ID: "res-failed-left", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/failed-left.png", MimeType: "image/png", Size: 7,
		UploadKey: &identity, Error: "write failed", CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := svc.repo.CreateResource(failed); err != nil {
		t.Fatal(err)
	}

	restarted := &Service{repo: svc.repo, dataDir: svc.dataDir}
	restarted.resourceDomain()
	usage, err := restarted.repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 0 {
		t.Fatalf("FAILED leftover daily=%d err=%v", usage, err)
	}
	row, err := restarted.repo.UploadReservation("user-1", identity)
	if err != nil || row != nil {
		t.Fatalf("FAILED leftover witness %#v err=%v", row, err)
	}
	got, err := restarted.resourceDomain().RetryOwned("user-1", failed.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if err != nil || got == nil || got.Status != model.ResourceStatusReady {
		t.Fatalf("retry after FAILED leftover = %#v err=%v", got, err)
	}
	usage, err = restarted.repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("retry daily=%d err=%v", usage, err)
	}
}

func TestDuplicateLiveUploadFileMapsToUploadInProgress(t *testing.T) {
	svc := newResourceTestService(t)
	announced := make(chan struct{})
	hold := make(chan struct{})
	original := svc.assets
	svc.assets = localasset.NewService(localasset.Dependencies{
		Repository: &holdCreateResourceRepo{Repository: localasset.NewRepository(svc.repo), announced: announced, hold: hold},
		Blobs:      localasset.NewFileStore(svc.dataDir),
		Quota:      resourceQuota{svc: svc},
		Lifecycle:  nopLifecycleAdapter{},
		DataDir:    svc.dataDir,
	})
	t.Cleanup(func() { svc.assets = original })

	var first *model.Resource
	var firstErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		first, firstErr = svc.UploadResourceFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "live-dup")
	}()
	<-announced
	_, dupErr := svc.UploadResourceFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "live-dup")
	if dupErr == nil || dupErr.Error() != localasset.UploadInProgress().Error() {
		t.Fatalf("duplicate live err=%v", dupErr)
	}
	close(hold)
	<-done
	if firstErr != nil || first == nil || first.Status != model.ResourceStatusReady {
		t.Fatalf("first upload = %#v err=%v", first, firstErr)
	}
}

type holdCreateResourceRepo struct {
	localasset.Repository
	announced chan struct{}
	hold      chan struct{}
	once      sync.Once
}

func (r *holdCreateResourceRepo) CreateResource(resource *model.Resource) error {
	r.once.Do(func() {
		close(r.announced)
		<-r.hold
	})
	return r.Repository.CreateResource(resource)
}

type nopLifecycleAdapter struct{}

func (nopLifecycleAdapter) RecordActivity(string, string, int) {}
func (nopLifecycleAdapter) AfterResourceReady(*model.Resource) {}
func (nopLifecycleAdapter) AppearanceReferencedIDs([]string) map[string]struct{} {
	return map[string]struct{}{}
}
func (nopLifecycleAdapter) RecycleRetentionDays() (int, error)   { return 0, nil }
func (nopLifecycleAdapter) WorkerID() string                     { return "test-worker" }
func (nopLifecycleAdapter) RunBackground(func())                 {}
func (nopLifecycleAdapter) DeleteUserAsset(string, string) error { return nil }
func (nopLifecycleAdapter) WithStorageLock(fn func() error) error {
	if fn == nil {
		return nil
	}
	return fn()
}
