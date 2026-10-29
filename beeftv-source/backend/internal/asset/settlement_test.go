package asset

import (
	"bytes"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/iotest"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type repoQuota struct {
	repo *repository.Repository
}

func (q repoQuota) ReserveUpload(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q repoQuota) ReserveChunked(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q repoQuota) ReserveRetry(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q repoQuota) ReserveGenerated(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q repoQuota) ReserveGeneratedRetry(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q repoQuota) Release(userID, day string, size int64, identity string) {
	_ = q.repo.ReleaseIdentifiedDailyUpload(userID, day, identity, size)
}
func (q repoQuota) ReleaseRetry(userID, day string, size int64, identity string) {
	_ = q.repo.ReleaseIdentifiedDailyUpload(userID, day, identity, size)
}
func (q repoQuota) Commit(userID string, _ int64, identity string) {
	_ = q.repo.ClearUploadReservation(userID, identity)
}

func (q repoQuota) reserve(userID string, size int64, identity string) (string, error) {
	day := time.Now().UTC().Format("2006-01-02")
	if err := q.repo.ReserveIdentifiedDailyUpload(userID, day, identity, size, 1<<40); err != nil {
		return "", err
	}
	return day, nil
}

func newRepoQuotaDomain(t *testing.T) (*Service, *repository.Repository, string) {
	t.Helper()
	_, repo, dataDir := newTestDomain(t)
	svc := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      repoQuota{repo: repo},
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	return svc, repo, dataDir
}

func plantReservation(t *testing.T, repo *repository.Repository, userID, identity string, size int64) string {
	t.Helper()
	day := time.Now().UTC().Format("2006-01-02")
	if err := repo.ReserveIdentifiedDailyUpload(userID, day, identity, size, 1<<40); err != nil {
		t.Fatal(err)
	}
	return day
}

func restartDomain(t *testing.T, repo *repository.Repository, dataDir string) *Service {
	t.Helper()
	return NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      repoQuota{repo: repo},
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
}

func reopenRepoQuotaDomain(t *testing.T, repo *repository.Repository, dataDir string) (*Service, *repository.Repository) {
	t.Helper()
	sqlDB, err := repo.DB().DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := gorm.Open(sqlite.Open(filepath.Join(dataDir, "meta.db")+"?_busy_timeout=5000&_foreign_keys=on"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Resource{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{}); err != nil {
		t.Fatal(err)
	}
	reopened := repository.New(db)
	svc := NewService(Dependencies{
		Repository: NewRepository(reopened),
		Blobs:      NewFileStore(dataDir),
		Quota:      repoQuota{repo: reopened},
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	return svc, reopened
}

func TestClaimCrashBeforeReserveThenRetryChargesDaily(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"claim-crash"})
	failed := model.Resource{
		ID: "res-claim-crash", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/claim-crash.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, Error: "write failed",
	}
	if err := repo.CreateResource(&failed); err != nil {
		t.Fatal(err)
	}
	claimed, err := repo.ClaimFailedResourceUpload("user-1", failed.ID)
	if err != nil || !claimed {
		t.Fatalf("explicit claim claimed=%v err=%v", claimed, err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 0 {
		t.Fatalf("after claim daily=%d err=%v", usage, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row != nil {
		t.Fatalf("after claim witness %#v err=%v", row, err)
	}

	svc, repo := reopenRepoQuotaDomain(t, repo, dataDir)
	got, err := svc.RetryOwned("user-1", failed.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if err != nil || got == nil || got.Status != model.ResourceStatusReady {
		t.Fatalf("retry after claim crash = %#v err=%v", got, err)
	}
	usage, err = repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("claim-crash retry daily=%d err=%v", usage, err)
	}
}

func TestLeftoverFailedClaimCrashKeepsOriginalDaily(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"leftover-claim-crash"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	failed := model.Resource{
		ID: "res-leftover-claim-crash", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/leftover-claim-crash.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, Error: "write failed",
	}
	if err := repo.CreateResource(&failed); err != nil {
		t.Fatal(err)
	}
	claimed, err := repo.ClaimFailedResourceUpload("user-1", failed.ID)
	if err != nil || !claimed {
		t.Fatalf("leftover claim claimed=%v err=%v", claimed, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row == nil {
		t.Fatalf("leftover claim witness %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("leftover claim daily=%d err=%v", usage, err)
	}

	svc, repo := reopenRepoQuotaDomain(t, repo, dataDir)
	got, err := svc.RetryOwned("user-1", failed.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if err != nil || got == nil || got.Status != model.ResourceStatusReady {
		t.Fatalf("leftover claim-crash retry = %#v err=%v", got, err)
	}
	usage, err = repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("leftover claim-crash daily=%d err=%v", usage, err)
	}
	row, err = repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row != nil {
		t.Fatalf("leftover claim-crash READY witness %#v err=%v", row, err)
	}
}

func TestPendingHeldWitnessReopenRetryDoesNotDoubleCharge(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"pending-held-reopen"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	pending := model.Resource{
		ID: "res-pending-held-reopen", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/pending-held-reopen.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&pending); err != nil {
		t.Fatal(err)
	}

	svc, repo := reopenRepoQuotaDomain(t, repo, dataDir)
	got, err := svc.RetryOwned("user-1", pending.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if err != nil || got == nil || got.Status != model.ResourceStatusReady {
		t.Fatalf("pending held reopen retry = %#v err=%v", got, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("pending held reopen daily=%d err=%v", usage, err)
	}
}

func TestReadyReopenRetryDoesNotReserve(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"ready-reopen"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	ready := model.Resource{
		ID: "res-ready-reopen", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/ready-reopen.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&ready); err != nil {
		t.Fatal(err)
	}
	if err := NewFileStore(dataDir).Write(ready.ObjectKey, bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}

	svc, repo := reopenRepoQuotaDomain(t, repo, dataDir)
	got, err := svc.RetryOwned("user-1", ready.ID, "image", "image/png", 7, bytes.NewReader([]byte("ignored")))
	if err != nil || got == nil || got.Status != model.ResourceStatusReady {
		t.Fatalf("READY reopen retry = %#v err=%v", got, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("READY reopen daily=%d err=%v", usage, err)
	}
}

func TestFailedBytesPromoteReservesWhenWitnessMissing(t *testing.T) {
	svc, repo, dataDir := newRepoQuotaDomain(t)
	identity := "task-failed-bytes:0"
	uploadKey := NormalizedUploadKey([]string{identity})
	failed := model.Resource{
		ID: "res-failed-bytes", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/failed-bytes.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, Error: "write failed",
	}
	if err := repo.CreateResource(&failed); err != nil {
		t.Fatal(err)
	}
	if err := NewFileStore(dataDir).Write(failed.ObjectKey, bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	got, err := svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		t.Fatal("FAILED+bytes called restore")
		return RecoveredArtifact{}, nil
	})
	if err != nil || got == nil || got.Status != model.ResourceStatusReady {
		t.Fatalf("FAILED+bytes promote = %#v err=%v", got, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("FAILED+bytes promote daily=%d err=%v", usage, err)
	}
}

func TestLeftoverFailedBytesPromoteKeepsOriginalDaily(t *testing.T) {
	svc, repo, dataDir := newRepoQuotaDomain(t)
	identity := "task-failed-bytes-held:0"
	uploadKey := NormalizedUploadKey([]string{identity})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	failed := model.Resource{
		ID: "res-failed-bytes-held", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/failed-bytes-held.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, Error: "write failed",
	}
	if err := repo.CreateResource(&failed); err != nil {
		t.Fatal(err)
	}
	if err := NewFileStore(dataDir).Write(failed.ObjectKey, bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}
	got, err := svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		t.Fatal("leftover FAILED+bytes called restore")
		return RecoveredArtifact{}, nil
	})
	if err != nil || got == nil || got.Status != model.ResourceStatusReady {
		t.Fatalf("leftover FAILED+bytes promote = %#v err=%v", got, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("leftover FAILED+bytes daily=%d err=%v", usage, err)
	}
}

func TestReadyMissingRestoreWriteFailureReopenKeepsDaily(t *testing.T) {
	svc, repo, dataDir := newRepoQuotaDomain(t)
	identity := "task-ready-repair-write:0"
	first, err := svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		return testArtifact("payload"), nil
	})
	if err != nil || first == nil || first.Status != model.ResourceStatusReady {
		t.Fatalf("first recover = %#v err=%v", first, err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("consumed daily=%d err=%v", usage, err)
	}
	if err := NewFileStore(dataDir).Delete(first.ObjectKey); err != nil {
		t.Fatal(err)
	}
	_, err = svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		artifact := testArtifact("payload")
		artifact.Body = iotest.ErrReader(errors.New("injected restore write failure"))
		return artifact, nil
	})
	if err == nil {
		t.Fatal("missing-byte restore write succeeded")
	}
	latest, lookupErr := repo.Resource(first.ID)
	if lookupErr != nil {
		t.Fatal(lookupErr)
	}
	if latest.Status != model.ResourceStatusReady {
		t.Fatalf("repair write failure mutated consumed status=%s", latest.Status)
	}

	svc, repo = reopenRepoQuotaDomain(t, repo, dataDir)
	second, err := svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		return testArtifact("payload"), nil
	})
	if err != nil || second == nil || second.ID != first.ID || second.Status != model.ResourceStatusReady {
		t.Fatalf("repair after reopen = %#v err=%v first=%s", second, err, first.ID)
	}
	if second.UploadKey == nil || first.UploadKey == nil || *second.UploadKey != *first.UploadKey {
		t.Fatalf("repair identity first=%v second=%v", first.UploadKey, second.UploadKey)
	}
	usage, err = repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("repair reopen daily=%d err=%v", usage, err)
	}
}

func TestReadyMissingRestoreSaveFailureReopenKeepsDaily(t *testing.T) {
	svc, repo, dataDir := newRepoQuotaDomain(t)
	identity := "task-ready-repair-save:0"
	first, err := svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		return testArtifact("payload"), nil
	})
	if err != nil || first == nil || first.Status != model.ResourceStatusReady {
		t.Fatalf("first recover = %#v err=%v", first, err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	if err := NewFileStore(dataDir).Delete(first.ObjectKey); err != nil {
		t.Fatal(err)
	}
	failing := NewService(Dependencies{
		Repository: &readySaveFailRepo{Repository: NewRepository(repo), remaining: 1},
		Blobs:      NewFileStore(dataDir),
		Quota:      repoQuota{repo: repo},
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	_, err = failing.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		return testArtifact("payload"), nil
	})
	if err == nil {
		t.Fatal("missing-byte restore ready-save succeeded")
	}
	latest, lookupErr := repo.Resource(first.ID)
	if lookupErr != nil {
		t.Fatal(lookupErr)
	}
	if latest.Status != model.ResourceStatusReady {
		t.Fatalf("repair save failure mutated consumed status=%s", latest.Status)
	}

	svc, repo = reopenRepoQuotaDomain(t, repo, dataDir)
	second, err := svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		t.Fatal("READY+restored bytes called restore")
		return RecoveredArtifact{}, nil
	})
	if err != nil || second == nil || second.ID != first.ID || second.Status != model.ResourceStatusReady {
		t.Fatalf("repair save reopen = %#v err=%v first=%s", second, err, first.ID)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("repair save reopen daily=%d err=%v", usage, err)
	}
}

func TestPendingRestoreWriteFailureRefundsDaily(t *testing.T) {
	svc, repo, dataDir := newRepoQuotaDomain(t)
	identity := "task-pending-write-fail:0"
	uploadKey := NormalizedUploadKey([]string{identity})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	pending := model.Resource{
		ID: "res-pending-write-fail", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/pending-write-fail.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&pending); err != nil {
		t.Fatal(err)
	}
	got, err := svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		artifact := testArtifact("payload")
		artifact.Body = iotest.ErrReader(errors.New("injected pending write failure"))
		return artifact, nil
	})
	if err == nil {
		t.Fatal("pending restore write succeeded")
	}
	if got == nil || got.Status != model.ResourceStatusFailed {
		t.Fatalf("pending write failure resource=%#v", got)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 0 {
		t.Fatalf("pending write failure daily=%d err=%v", usage, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row != nil {
		t.Fatalf("pending write failure witness %#v err=%v", row, err)
	}
	if statErr := NewFileStore(dataDir).Exists(pending.ObjectKey); statErr == nil {
		t.Fatal("pending write failure left bytes")
	}
}

func TestLeftoverReadyRestartDeleteKeepsDaily(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"ready-left"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	resource := model.Resource{
		ID: "res-ready-left", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/ready-left.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}

	restartDomain(t, repo, dataDir)
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("after restart daily=%d err=%v", usage, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row != nil {
		t.Fatalf("READY leftover witness %#v err=%v", row, err)
	}

	if err := repo.DeleteResource("user-1", resource.ID); err != nil {
		t.Fatal(err)
	}
	restartDomain(t, repo, dataDir)
	usage, err = repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("delete then restart refunded daily=%d err=%v", usage, err)
	}
}

func TestLeftoverReadyDeleteBeforeRestartKeepsDaily(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"ready-delete-first"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	resource := model.Resource{
		ID: "res-ready-delete-first", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/ready-delete-first.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteResource("user-1", resource.ID); err != nil {
		t.Fatal(err)
	}
	restartDomain(t, repo, dataDir)
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("delete-before-restart refunded daily=%d err=%v", usage, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row != nil {
		t.Fatalf("delete-before-restart witness %#v err=%v", row, err)
	}
}

func TestLeftoverFailedRestartRetrySucceeds(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"failed-left"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	failed := model.Resource{
		ID: "res-failed-left", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/failed-left.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, Error: "write failed",
	}
	if err := repo.CreateResource(&failed); err != nil {
		t.Fatal(err)
	}

	svc := restartDomain(t, repo, dataDir)
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 0 {
		t.Fatalf("FAILED leftover daily=%d err=%v", usage, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row != nil {
		t.Fatalf("FAILED leftover witness %#v err=%v", row, err)
	}

	got, err := svc.RetryOwned("user-1", failed.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if err != nil || got == nil || got.Status != model.ResourceStatusReady {
		t.Fatalf("retry after FAILED leftover = %#v err=%v", got, err)
	}
	usage, err = repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("retry daily=%d err=%v", usage, err)
	}
}

func TestLeftoverFailedFirstRetrySucceedsWithoutRestart(t *testing.T) {
	svc, repo, _ := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"failed-first-retry"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	failed := model.Resource{
		ID: "res-failed-first-retry", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/failed-first-retry.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, Error: "write failed",
	}
	if err := repo.CreateResource(&failed); err != nil {
		t.Fatal(err)
	}
	got, err := svc.RetryOwned("user-1", failed.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if err != nil || got == nil || got.Status != model.ResourceStatusReady {
		t.Fatalf("first retry leftover FAILED = %#v err=%v", got, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("first retry daily=%d err=%v", usage, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row != nil {
		t.Fatalf("first retry witness %#v err=%v", row, err)
	}
}

func TestLeftoverFailedConcurrentRetrySettlesOnce(t *testing.T) {
	svc, repo, _ := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"failed-concurrent"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	failed := model.Resource{
		ID: "res-failed-concurrent", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/failed-concurrent.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, Error: "write failed",
	}
	if err := repo.CreateResource(&failed); err != nil {
		t.Fatal(err)
	}

	var first, second *model.Resource
	var firstErr, secondErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		first, firstErr = svc.RetryOwned("user-1", failed.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	}()
	go func() {
		defer wg.Done()
		second, secondErr = svc.RetryOwned("user-1", failed.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	}()
	wg.Wait()
	if firstErr != nil && !isAppError(firstErr, UploadInProgress()) {
		t.Fatalf("first concurrent retry err=%v", firstErr)
	}
	if secondErr != nil && !isAppError(secondErr, UploadInProgress()) {
		t.Fatalf("second concurrent retry err=%v", secondErr)
	}
	ready := 0
	for _, got := range []*model.Resource{first, second} {
		if got != nil && got.Status == model.ResourceStatusReady {
			ready++
		}
	}
	if ready == 0 {
		t.Fatalf("no READY retry first=%#v err=%v second=%#v err=%v", first, firstErr, second, secondErr)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("concurrent retry daily=%d err=%v", usage, err)
	}
}

func TestPendingConcurrentRetryKeepsSingleWitness(t *testing.T) {
	svc, repo, _ := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"pending-concurrent"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	pending := model.Resource{
		ID: "res-pending-concurrent", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/pending-concurrent.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&pending); err != nil {
		t.Fatal(err)
	}

	var first, second *model.Resource
	var firstErr, secondErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		first, firstErr = svc.RetryOwned("user-1", pending.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	}()
	go func() {
		defer wg.Done()
		second, secondErr = svc.RetryOwned("user-1", pending.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	}()
	wg.Wait()
	if firstErr != nil {
		t.Fatalf("first pending retry err=%v", firstErr)
	}
	if secondErr != nil {
		t.Fatalf("second pending retry err=%v", secondErr)
	}
	if first == nil || first.Status != model.ResourceStatusReady || second == nil || second.Status != model.ResourceStatusReady {
		t.Fatalf("pending concurrent first=%#v second=%#v", first, second)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("pending concurrent daily=%d err=%v", usage, err)
	}
}

func TestUploadFileWithoutClientKeyMintsWitnessIdentity(t *testing.T) {
	svc, repo, _ := newRepoQuotaDomain(t)
	got, err := svc.UploadFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")))
	if err != nil || got == nil || got.UploadKey == nil || strings.TrimSpace(*got.UploadKey) == "" {
		t.Fatalf("unkeyed UploadFile = %#v err=%v", got, err)
	}
	row, err := repo.UploadReservation("user-1", *got.UploadKey)
	if err != nil || row != nil {
		t.Fatalf("minted READY witness %#v err=%v", row, err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("minted daily=%d err=%v", usage, err)
	}
}

func TestStoreGeneratedMintsWitnessIdentity(t *testing.T) {
	svc, repo, _ := newRepoQuotaDomain(t)
	got, err := svc.StoreGenerated("user-1", "image", "a.png", "image/png", 7, 1, 1, 0, bytes.NewReader([]byte("payload")))
	if err != nil || got == nil || got.UploadKey == nil || strings.TrimSpace(*got.UploadKey) == "" {
		t.Fatalf("StoreGenerated = %#v err=%v", got, err)
	}
	row, err := repo.UploadReservation("user-1", *got.UploadKey)
	if err != nil || row != nil {
		t.Fatalf("generated READY witness %#v err=%v", row, err)
	}
}

func TestSameKeyReuploadAfterDelete(t *testing.T) {
	svc, repo, _ := newRepoQuotaDomain(t)
	first, err := svc.UploadFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "reuse-key")
	if err != nil || first == nil {
		t.Fatalf("first = %#v err=%v", first, err)
	}
	if err := repo.DeleteResource("user-1", first.ID); err != nil {
		t.Fatal(err)
	}
	second, err := svc.UploadFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "reuse-key")
	if err != nil || second == nil || second.ID == first.ID {
		t.Fatalf("reupload after delete = %#v err=%v first=%s", second, err, first.ID)
	}
}

func TestV13CrashBeforeReserveMissingWitnessChargesOnce(t *testing.T) {
	svc, repo, dataDir := newRepoQuotaDomain(t)
	identity := "v13-crash-before-reserve"
	uploadKey := NormalizedUploadKey([]string{identity})
	pending := model.Resource{
		ID: "res-v13-missing-witness", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/v13-missing-witness.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&pending); err != nil {
		t.Fatal(err)
	}
	if err := NewFileStore(dataDir).Write(pending.ObjectKey, bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 0 {
		t.Fatalf("before recover daily=%d err=%v", usage, err)
	}
	first, err := svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		t.Fatal("v13 leftover with bytes called restore")
		return RecoveredArtifact{}, nil
	})
	if err != nil || first == nil || first.Status != model.ResourceStatusReady {
		t.Fatalf("first recover = %#v err=%v", first, err)
	}
	usage, err = repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("after first daily=%d err=%v", usage, err)
	}
	second, err := svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		t.Fatal("READY replay called restore")
		return RecoveredArtifact{}, nil
	})
	if err != nil || second == nil || second.ID != first.ID || second.Status != model.ResourceStatusReady {
		t.Fatalf("second recover = %#v err=%v", second, err)
	}
	usage, err = repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("after second daily=%d err=%v", usage, err)
	}
}

func TestUnattributedLegacyPendingDoesNotReserve(t *testing.T) {
	svc, repo, dataDir := newRepoQuotaDomain(t)
	identity := "legacy-unattributed"
	uploadKey := NormalizedUploadKey([]string{identity})
	pending := model.Resource{
		ID: "res-legacy-unattributed", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/legacy-unattributed.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&pending); err != nil {
		t.Fatal(err)
	}
	if err := NewFileStore(dataDir).Write(pending.ObjectKey, bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	day := now.UTC().Format("2006-01-02")
	if err := repo.DB().Create(&model.UserDailyUploadUsage{
		ID: "user-1:" + day, UserID: "user-1", Day: day, Bytes: 7, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DB().Create(&model.UserUploadReservation{
		ID: "user-1:" + *uploadKey, UserID: "user-1", Identity: *uploadKey,
		Day: model.UploadReservationUnattributedDay, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	got, err := svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		t.Fatal("unattributed leftover called restore")
		return RecoveredArtifact{}, nil
	})
	if err == nil || !strings.Contains(err.Error(), "无法确认用量") {
		t.Fatalf("unattributed recover = %#v err=%v", got, err)
	}
	if got == nil || got.Status != model.ResourceStatusPending {
		t.Fatalf("unattributed mutated %#v", got)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("unattributed daily=%d err=%v", usage, err)
	}
}

func TestUnattributedFailedSaveRetryAndRestartKeepMarker(t *testing.T) {
	svc, repo, dataDir := newRepoQuotaDomain(t)
	identity := "unattributed-retry"
	uploadKey := NormalizedUploadKey([]string{identity})
	failed := model.Resource{
		ID: "res-unattributed-retry", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/unattributed-retry.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, Error: "write failed",
	}
	if err := repo.CreateResource(&failed); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	day := now.UTC().Format("2006-01-02")
	if err := repo.DB().Create(&model.UserDailyUploadUsage{
		ID: "user-1:" + day, UserID: "user-1", Day: day, Bytes: 7, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DB().Create(&model.UserUploadReservation{
		ID: "user-1:" + *uploadKey, UserID: "user-1", Identity: *uploadKey,
		Day: model.UploadReservationUnattributedDay, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	got, err := svc.RetryOwned("user-1", failed.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if err == nil || !strings.Contains(err.Error(), "无法确认用量") {
		t.Fatalf("unattributed retry = %#v err=%v", got, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row == nil || !row.Unattributed() {
		t.Fatalf("retry persistFailed cleared sentinel %#v err=%v", row, err)
	}
	latest, err := repo.Resource(failed.ID)
	if err != nil || latest == nil || latest.Status != model.ResourceStatusFailed {
		t.Fatalf("retry persistFailed status %#v err=%v", latest, err)
	}
	svc = restartDomain(t, repo, dataDir)
	row, err = repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row == nil || !row.Unattributed() {
		t.Fatalf("FAILED leftover restart cleared sentinel %#v err=%v", row, err)
	}

	claimed, err := repo.ClaimFailedResourceUpload("user-1", failed.ID)
	if err != nil || !claimed {
		t.Fatalf("claim claimed=%v err=%v", claimed, err)
	}
	row, err = repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row == nil || !row.Unattributed() {
		t.Fatalf("claim cleared sentinel %#v err=%v", row, err)
	}

	for i := 0; i < 2; i++ {
		svc = restartDomain(t, repo, dataDir)
		row, err = repo.UploadReservation("user-1", *uploadKey)
		if err != nil || row == nil || !row.Unattributed() {
			t.Fatalf("restart %d cleared sentinel %#v err=%v", i, row, err)
		}
		usage, usageErr := repo.DailyUploadBytes("user-1", day)
		if usageErr != nil || usage != 7 {
			t.Fatalf("restart %d daily=%d err=%v", i, usage, usageErr)
		}
		got, err = svc.RetryOwned("user-1", failed.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
		if err == nil || !strings.Contains(err.Error(), "无法确认用量") {
			t.Fatalf("restart %d retry = %#v err=%v", i, got, err)
		}
	}
}

func TestUnattributedDeleteThenReuploadReserves(t *testing.T) {
	svc, repo, _ := newRepoQuotaDomain(t)
	identity := "unattributed-reupload"
	uploadKey := NormalizedUploadKey([]string{identity})
	pending := model.Resource{
		ID: "res-unattributed-reupload", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/unattributed-reupload.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&pending); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	day := now.UTC().Format("2006-01-02")
	if err := repo.DB().Create(&model.UserDailyUploadUsage{
		ID: "user-1:" + day, UserID: "user-1", Day: day, Bytes: 7, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DB().Create(&model.UserUploadReservation{
		ID: "user-1:" + *uploadKey, UserID: "user-1", Identity: *uploadKey,
		Day: model.UploadReservationUnattributedDay, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteResource("user-1", pending.ID); err != nil {
		t.Fatal(err)
	}
	second, err := svc.UploadFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), identity)
	if err != nil || second == nil || second.ID == pending.ID || second.Status != model.ResourceStatusReady {
		t.Fatalf("reupload after unattributed delete = %#v err=%v", second, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 14 {
		t.Fatalf("reupload daily=%d err=%v", usage, err)
	}
}

func TestV13PositiveWitnessSkipsReserve(t *testing.T) {
	svc, repo, dataDir := newRepoQuotaDomain(t)
	identity := "v13-positive-witness"
	uploadKey := NormalizedUploadKey([]string{identity})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	pending := model.Resource{
		ID: "res-v13-positive", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/v13-positive.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&pending); err != nil {
		t.Fatal(err)
	}
	if err := NewFileStore(dataDir).Write(pending.ObjectKey, bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}
	got, err := svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		t.Fatal("positive witness called restore")
		return RecoveredArtifact{}, nil
	})
	if err != nil || got == nil || got.Status != model.ResourceStatusReady {
		t.Fatalf("positive witness recover = %#v err=%v", got, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("positive witness daily=%d err=%v", usage, err)
	}
}

func TestPendingRestartRetainsWitness(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"pending-keep"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	pending := model.Resource{
		ID: "res-pending-keep", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/pending-keep.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&pending); err != nil {
		t.Fatal(err)
	}

	restartDomain(t, repo, dataDir)
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("PENDING restart daily=%d err=%v", usage, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row == nil {
		t.Fatalf("PENDING witness released %#v err=%v", row, err)
	}
}

type holdCreateRepo struct {
	Repository
	announced chan struct{}
	hold      chan struct{}
	once      sync.Once
}

func (r *holdCreateRepo) CreateResource(resource *model.Resource) error {
	r.once.Do(func() {
		close(r.announced)
		<-r.hold
	})
	return r.Repository.CreateResource(resource)
}

func TestDuplicateLiveUploadFileReturnsUploadInProgress(t *testing.T) {
	_, repo, dataDir := newTestDomain(t)
	announced := make(chan struct{})
	hold := make(chan struct{})
	svc := NewService(Dependencies{
		Repository: &holdCreateRepo{Repository: NewRepository(repo), announced: announced, hold: hold},
		Blobs:      NewFileStore(dataDir),
		Quota:      repoQuota{repo: repo},
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})

	var first *model.Resource
	var firstErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		first, firstErr = svc.UploadFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "live-dup")
	}()
	<-announced
	_, dupErr := svc.UploadFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "live-dup")
	if !isAppError(dupErr, UploadInProgress()) {
		t.Fatalf("duplicate live err=%v", dupErr)
	}
	close(hold)
	<-done
	if firstErr != nil || first == nil || first.Status != model.ResourceStatusReady {
		t.Fatalf("first upload = %#v err=%v", first, firstErr)
	}
}

func TestEmptyDataDirSkipsReservationRecovery(t *testing.T) {
	_, repo, _ := newTestDomain(t)
	uploadKey := NormalizedUploadKey([]string{"no-datadir"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(t.TempDir()),
		Quota:      repoQuota{repo: repo},
		Lifecycle:  nopLifecycle{},
	})
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row == nil {
		t.Fatalf("empty DataDir recovered witness %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("empty DataDir daily=%d err=%v", usage, err)
	}
}

func TestMissingResourceOrphanReleasesOnce(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	identity := *NormalizedUploadKey([]string{"orphan-missing"})
	day := plantReservation(t, repo, "user-1", identity, 7)
	restartDomain(t, repo, dataDir)
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 0 {
		t.Fatalf("missing resource daily=%d err=%v", usage, err)
	}
	restartDomain(t, repo, dataDir)
	usage, err = repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 0 {
		t.Fatalf("second restart changed daily=%d err=%v", usage, err)
	}
}
