package asset

import (
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type nopQuota struct{}

func (nopQuota) ReserveUpload(string, int64, string) (string, error)         { return "day", nil }
func (nopQuota) ReserveChunked(string, int64, string) (string, error)        { return "day", nil }
func (nopQuota) ReserveRetry(string, int64, string) (string, error)          { return "day", nil }
func (nopQuota) ReserveGenerated(string, int64, string) (string, error)      { return "day", nil }
func (nopQuota) ReserveGeneratedRetry(string, int64, string) (string, error) { return "day", nil }
func (nopQuota) Release(string, string, int64, string)                       {}
func (nopQuota) ReleaseRetry(string, string, int64, string)                  {}
func (nopQuota) Commit(string, int64, string)                                {}

type recordingQuota struct {
	reserved int64
}

func (q *recordingQuota) ReserveUpload(_ string, size int64, _ string) (string, error) {
	q.reserved += size
	return "day", nil
}
func (q *recordingQuota) ReserveChunked(_ string, size int64, _ string) (string, error) {
	q.reserved += size
	return "day", nil
}
func (q *recordingQuota) ReserveRetry(_ string, size int64, _ string) (string, error) {
	q.reserved += size
	return "day", nil
}
func (q *recordingQuota) ReserveGenerated(_ string, size int64, _ string) (string, error) {
	q.reserved += size
	return "day", nil
}
func (q *recordingQuota) ReserveGeneratedRetry(_ string, size int64, _ string) (string, error) {
	q.reserved += size
	return "day", nil
}
func (q *recordingQuota) Release(_ string, _ string, size int64, _ string)      { q.reserved -= size }
func (q *recordingQuota) ReleaseRetry(_ string, _ string, size int64, _ string) { q.reserved -= size }
func (q *recordingQuota) Commit(string, int64, string)                          {}

type nopLifecycle struct{}

func (nopLifecycle) RecordActivity(string, string, int) {}
func (nopLifecycle) AfterResourceReady(*model.Resource) {}
func (nopLifecycle) AppearanceReferencedIDs([]string) map[string]struct{} {
	return map[string]struct{}{}
}
func (nopLifecycle) RecycleRetentionDays() (int, error)   { return 0, nil }
func (nopLifecycle) WorkerID() string                     { return "test-worker" }
func (nopLifecycle) RunBackground(func())                 {}
func (nopLifecycle) DeleteUserAsset(string, string) error { return nil }
func (nopLifecycle) WithStorageLock(fn func() error) error {
	if fn == nil {
		return nil
	}
	return fn()
}

type readySaveFailRepo struct {
	Repository
	remaining int
}

func (r *readySaveFailRepo) SaveResource(resource *model.Resource) error {
	if resource != nil && resource.Status == model.ResourceStatusReady && r.remaining > 0 {
		r.remaining--
		return errReadySave
	}
	return r.Repository.SaveResource(resource)
}

func newTestDomain(t *testing.T) (*Service, *repository.Repository, string) {
	t.Helper()
	dataDir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dataDir, "meta.db")+"?_busy_timeout=5000&_foreign_keys=on"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.Resource{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	return NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      nopQuota{},
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	}), repo, dataDir
}
