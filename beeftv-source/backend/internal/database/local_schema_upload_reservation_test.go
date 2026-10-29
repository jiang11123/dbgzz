package database

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

func TestMixedUnpaidReadyAndPaidPendingEqualDailyStayUnattributed(t *testing.T) {
	db, path := openFileDB(t)
	stampHistorical(t, db, "product-v3")
	if err := db.AutoMigrate(&model.UserDailyUploadUsage{}); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Dir(path)
	now := time.Now()
	day := now.UTC().Format("2006-01-02")
	size := int64(7)
	if err := db.Create(&model.UserDailyUploadUsage{
		ID: "user-1:" + day, UserID: "user-1", Day: day, Bytes: size, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Resource{
		ID: "res-unpaid-ready", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/unpaid-ready.png", MimeType: "image/png", Size: size,
		CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	identity := "paid-pending"
	uploadKey := localasset.NormalizedUploadKey([]string{identity})
	pending := model.Resource{
		ID: "res-paid-pending", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/paid-pending.png", MimeType: "image/png", Size: size,
		UploadKey: uploadKey, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&pending).Error; err != nil {
		t.Fatal(err)
	}
	if err := localasset.NewFileStore(dataDir).Write(pending.ObjectKey, bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	assertDailyBytes(t, db, "user-1", day, size)
	assertReservation(t, db, "user-1", *uploadKey, model.UploadReservationUnattributedDay, 0)
	assertNoReservation(t, db, "user-1", "res-unpaid-ready")

	svc, repo := reopenMigratedAssetService(t, db, path, dataDir)
	restore := func() (localasset.RecoveredArtifact, error) {
		t.Fatal("unattributed leftover called restore")
		return localasset.RecoveredArtifact{}, nil
	}
	got, err := svc.RecoverOwned("user-1", identity, restore)
	if err == nil || !strings.Contains(err.Error(), "无法确认用量") {
		t.Fatalf("mixed recover = %#v err=%v", got, err)
	}
	if got == nil || got.Status != model.ResourceStatusPending {
		t.Fatalf("mixed mutated %#v", got)
	}
	assertDailyBytes(t, repo.DB(), "user-1", day, size)

	for i := 0; i < 2; i++ {
		svc = restartMigratedAssetService(t, repo, dataDir)
		got, err = svc.RecoverOwned("user-1", identity, restore)
		if err == nil || !strings.Contains(err.Error(), "无法确认用量") {
			t.Fatalf("restart %d recover = %#v err=%v", i, got, err)
		}
		assertDailyBytes(t, repo.DB(), "user-1", day, size)
		assertReservation(t, repo.DB(), "user-1", *uploadKey, model.UploadReservationUnattributedDay, 0)
	}
	ready, err := repo.Resource("res-unpaid-ready")
	if err != nil || ready == nil || ready.Status != model.ResourceStatusReady {
		t.Fatalf("READY mutated %#v err=%v", ready, err)
	}
}

func TestUnrelatedDayUsageDoesNotAttributePending(t *testing.T) {
	db, _ := openFileDB(t)
	stampHistorical(t, db, "product-v3")
	if err := db.AutoMigrate(&model.UserDailyUploadUsage{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	today := now.UTC().Format("2006-01-02")
	yesterday := now.UTC().AddDate(0, 0, -1).Format("2006-01-02")
	if err := db.Create(&model.UserDailyUploadUsage{
		ID: "user-1:" + yesterday, UserID: "user-1", Day: yesterday, Bytes: 11, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	uploadKey := "today-pending"
	if err := db.Create(&model.Resource{
		ID: "res-today-pending", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", Size: 7, UploadKey: &uploadKey, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	assertDailyBytes(t, db, "user-1", yesterday, 11)
	assertDailyBytes(t, db, "user-1", today, 0)
	assertReservation(t, db, "user-1", uploadKey, model.UploadReservationUnattributedDay, 0)
}

func TestFailedPreRefundCrashStaysUnattributedAcrossRestarts(t *testing.T) {
	db, path := openFileDB(t)
	stampHistorical(t, db, "product-v3")
	if err := db.AutoMigrate(&model.UserDailyUploadUsage{}); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Dir(path)
	now := time.Now()
	day := now.UTC().Format("2006-01-02")
	size := int64(7)
	if err := db.Create(&model.UserDailyUploadUsage{
		ID: "user-1:" + day, UserID: "user-1", Day: day, Bytes: size, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	identity := "failed-pre-refund"
	uploadKey := localasset.NormalizedUploadKey([]string{identity})
	failed := model.Resource{
		ID: "res-failed-pre-refund", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/failed-pre-refund.png", MimeType: "image/png", Size: size,
		UploadKey: uploadKey, Error: "write failed", CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&failed).Error; err != nil {
		t.Fatal(err)
	}
	if err := localasset.NewFileStore(dataDir).Write(failed.ObjectKey, bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	assertDailyBytes(t, db, "user-1", day, size)
	assertReservation(t, db, "user-1", *uploadKey, model.UploadReservationUnattributedDay, 0)

	svc, repo := reopenMigratedAssetService(t, db, path, dataDir)
	restore := func() (localasset.RecoveredArtifact, error) {
		t.Fatal("unattributed FAILED called restore")
		return localasset.RecoveredArtifact{}, nil
	}
	got, err := svc.RecoverOwned("user-1", identity, restore)
	if err == nil || !strings.Contains(err.Error(), "无法确认用量") {
		t.Fatalf("failed recover = %#v err=%v", got, err)
	}
	for i := 0; i < 2; i++ {
		svc = restartMigratedAssetService(t, repo, dataDir)
		got, err = svc.RecoverOwned("user-1", identity, restore)
		if err == nil || !strings.Contains(err.Error(), "无法确认用量") {
			t.Fatalf("failed restart %d = %#v err=%v", i, got, err)
		}
		assertDailyBytes(t, repo.DB(), "user-1", day, size)
		assertReservation(t, repo.DB(), "user-1", *uploadKey, model.UploadReservationUnattributedDay, 0)
		row, lookupErr := repo.Resource(failed.ID)
		if lookupErr != nil || row == nil || row.Status != model.ResourceStatusFailed {
			t.Fatalf("failed restart %d mutated %#v err=%v", i, row, lookupErr)
		}
	}
}

func TestUnpaidLegacyPendingIsUnattributed(t *testing.T) {
	db, _ := openFileDB(t)
	stampHistorical(t, db, "product-v3")
	if err := db.AutoMigrate(&model.UserDailyUploadUsage{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	uploadKey := "retry-before-reserve"
	if err := db.Create(&model.Resource{
		ID: "res-unpaid-pending", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", Size: 7, UploadKey: &uploadKey, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	assertReservation(t, db, "user-1", uploadKey, model.UploadReservationUnattributedDay, 0)
	assertDailyBytes(t, db, "user-1", now.UTC().Format("2006-01-02"), 0)
}

func TestLegacyUnattributedBackfillSkipsReadyAndKeepsPositiveWitness(t *testing.T) {
	db, path := openFileDB(t)
	stampHistorical(t, db, "product-v3")
	if err := db.AutoMigrate(&model.UserDailyUploadUsage{}, &model.UserUploadReservation{}); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Dir(path)
	now := time.Now()
	day := now.UTC().Format("2006-01-02")
	size := int64(7)
	if err := db.Create(&model.UserDailyUploadUsage{
		ID: "user-1:" + day, UserID: "user-1", Day: day, Bytes: size, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	identity := "already-identified"
	uploadKey := localasset.NormalizedUploadKey([]string{identity})
	pending := model.Resource{
		ID: "res-identified-pending", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/identified-pending.png", MimeType: "image/png", Size: size,
		UploadKey: uploadKey, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&pending).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.UserUploadReservation{
		ID: "user-1:" + *uploadKey, UserID: "user-1", Identity: *uploadKey, Day: day, Size: size,
		CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Resource{
		ID: "res-ready-skip", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", Size: size, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := localasset.NewFileStore(dataDir).Write(pending.ObjectKey, bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	assertReservation(t, db, "user-1", *uploadKey, day, size)
	assertNoReservation(t, db, "user-1", "res-ready-skip")
	assertDailyBytes(t, db, "user-1", day, size)

	svc, repo := reopenMigratedAssetService(t, db, path, dataDir)
	got, err := svc.RecoverOwned("user-1", identity, func() (localasset.RecoveredArtifact, error) {
		t.Fatal("identified leftover called restore")
		return localasset.RecoveredArtifact{}, nil
	})
	if err != nil || got == nil || got.Status != model.ResourceStatusReady {
		t.Fatalf("identified recover = %#v err=%v", got, err)
	}
	assertDailyBytes(t, repo.DB(), "user-1", day, size)
}

func TestV13MissingWitnessAfterMigrateStillReserves(t *testing.T) {
	db, path := openFileDB(t)
	stampHistorical(t, db, "product-v3")
	if err := db.AutoMigrate(&model.UserDailyUploadUsage{}); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Dir(path)
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc, repo := reopenMigratedAssetService(t, db, path, dataDir)
	identity := "v13-crash-before-reserve"
	uploadKey := localasset.NormalizedUploadKey([]string{identity})
	pending := model.Resource{
		ID: "res-v13-missing", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/v13-missing.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&pending); err != nil {
		t.Fatal(err)
	}
	if err := localasset.NewFileStore(dataDir).Write(pending.ObjectKey, bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	first, err := svc.RecoverOwned("user-1", identity, func() (localasset.RecoveredArtifact, error) {
		t.Fatal("v13 leftover with bytes called restore")
		return localasset.RecoveredArtifact{}, nil
	})
	if err != nil || first == nil || first.Status != model.ResourceStatusReady {
		t.Fatalf("v13 first recover = %#v err=%v", first, err)
	}
	assertDailyBytes(t, repo.DB(), "user-1", day, 7)
	second, err := svc.RecoverOwned("user-1", identity, func() (localasset.RecoveredArtifact, error) {
		t.Fatal("READY replay called restore")
		return localasset.RecoveredArtifact{}, nil
	})
	if err != nil || second == nil || second.ID != first.ID {
		t.Fatalf("v13 second recover = %#v err=%v", second, err)
	}
	assertDailyBytes(t, repo.DB(), "user-1", day, 7)
}

func TestTwoPendingOneDailyBothUnattributed(t *testing.T) {
	db, _ := openFileDB(t)
	stampHistorical(t, db, "product-v3")
	if err := db.AutoMigrate(&model.UserDailyUploadUsage{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	day := now.UTC().Format("2006-01-02")
	if err := db.Create(&model.UserDailyUploadUsage{
		ID: "user-1:" + day, UserID: "user-1", Day: day, Bytes: 70, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	firstKey, secondKey := "pending-a", "pending-b"
	for i, key := range []string{firstKey, secondKey} {
		resource := model.Resource{
			ID: "res-ambiguous-" + key, UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
			Provider: "local", Size: 70, UploadKey: &key, CreatedAt: now.Add(time.Duration(i) * time.Second), UpdatedAt: now,
		}
		if err := db.Create(&resource).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	assertDailyBytes(t, db, "user-1", day, 70)
	assertReservation(t, db, "user-1", firstKey, model.UploadReservationUnattributedDay, 0)
	assertReservation(t, db, "user-1", secondKey, model.UploadReservationUnattributedDay, 0)
}

func assertDailyBytes(t *testing.T, db *gorm.DB, userID, day string, want int64) {
	t.Helper()
	var got int64
	if err := db.Model(&model.UserDailyUploadUsage{}).Select("COALESCE(bytes, 0)").Where("user_id = ? AND day = ?", userID, day).Scan(&got).Error; err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("daily[%s %s]=%d want %d", userID, day, got, want)
	}
}

func assertReservation(t *testing.T, db *gorm.DB, userID, identity, day string, size int64) {
	t.Helper()
	var row model.UserUploadReservation
	if err := db.Where("user_id = ? AND identity = ?", userID, identity).First(&row).Error; err != nil {
		t.Fatalf("reservation %s: %v", identity, err)
	}
	if row.Day != day || row.Size != size {
		t.Fatalf("reservation = %#v want day=%s size=%d", row, day, size)
	}
}

func assertNoReservation(t *testing.T, db *gorm.DB, userID, identity string) {
	t.Helper()
	var count int64
	if err := db.Model(&model.UserUploadReservation{}).Where("user_id = ? AND identity = ?", userID, identity).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("reservation count = %d", count)
	}
}

func reopenMigratedAssetService(t *testing.T, db *gorm.DB, path, dataDir string) (*localasset.Service, *repository.Repository) {
	t.Helper()
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(Config{Driver: "sqlite", DSN: path + "?_busy_timeout=5000&_foreign_keys=on"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		conn, _ := reopened.DB()
		if conn != nil {
			_ = conn.Close()
		}
	})
	repo := repository.New(reopened)
	return restartMigratedAssetService(t, repo, dataDir), repo
}

func restartMigratedAssetService(t *testing.T, repo *repository.Repository, dataDir string) *localasset.Service {
	t.Helper()
	return localasset.NewService(localasset.Dependencies{
		Repository: localasset.NewRepository(repo),
		Blobs:      localasset.NewFileStore(dataDir),
		Quota:      migrateTestQuota{repo: repo},
		Lifecycle:  nopMigrateLifecycle{},
		DataDir:    dataDir,
	})
}

type migrateTestQuota struct {
	repo *repository.Repository
}

func (q migrateTestQuota) ReserveUpload(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q migrateTestQuota) ReserveChunked(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q migrateTestQuota) ReserveRetry(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q migrateTestQuota) ReserveGenerated(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q migrateTestQuota) ReserveGeneratedRetry(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q migrateTestQuota) Release(userID, day string, size int64, identity string) {
	_ = q.repo.ReleaseIdentifiedDailyUpload(userID, day, identity, size)
}
func (q migrateTestQuota) ReleaseRetry(userID, day string, size int64, identity string) {
	_ = q.repo.ReleaseIdentifiedDailyUpload(userID, day, identity, size)
}
func (q migrateTestQuota) Commit(userID string, _ int64, identity string) {
	_ = q.repo.ClearUploadReservation(userID, identity)
}
func (q migrateTestQuota) reserve(userID string, size int64, identity string) (string, error) {
	day := time.Now().UTC().Format("2006-01-02")
	if err := q.repo.ReserveIdentifiedDailyUpload(userID, day, identity, size, 1<<40); err != nil {
		return "", err
	}
	return day, nil
}

type nopMigrateLifecycle struct{}

func (nopMigrateLifecycle) RecordActivity(string, string, int)                   {}
func (nopMigrateLifecycle) AfterResourceReady(*model.Resource)                   {}
func (nopMigrateLifecycle) AppearanceReferencedIDs([]string) map[string]struct{} { return nil }
func (nopMigrateLifecycle) RecycleRetentionDays() (int, error)                   { return 0, nil }
func (nopMigrateLifecycle) WorkerID() string                                     { return "test" }
func (nopMigrateLifecycle) RunBackground(func())                                 {}
func (nopMigrateLifecycle) DeleteUserAsset(string, string) error                 { return nil }
func (nopMigrateLifecycle) WithStorageLock(fn func() error) error {
	if fn == nil {
		return nil
	}
	return fn()
}
