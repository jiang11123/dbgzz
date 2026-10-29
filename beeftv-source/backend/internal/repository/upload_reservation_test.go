package repository

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newUploadReservationRepo(t *testing.T) *Repository {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "upload.db")+"?_busy_timeout=5000&_foreign_keys=on"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Resource{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{}); err != nil {
		t.Fatal(err)
	}
	return New(db)
}

func TestReserveIdentifiedDailyUploadMapsUniqueToConflict(t *testing.T) {
	repo := newUploadReservationRepo(t)
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", "same-id", 7, 1000); err != nil {
		t.Fatal(err)
	}
	err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", "same-id", 7, 1000)
	if !errors.Is(err, ErrUploadReservationConflict) {
		t.Fatalf("duplicate reserve err=%v", err)
	}
	usage, err := repo.DailyUploadBytes("user-1", "2026-10-02")
	if err != nil || usage != 7 {
		t.Fatalf("daily=%d err=%v", usage, err)
	}
}

func TestSaveResourceReadyClearsWitnessAndKeepsDaily(t *testing.T) {
	repo := newUploadReservationRepo(t)
	identity := "ready-id"
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", identity, 7, 1000); err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{
		ID: "res-ready", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/a.png", Size: 7, UploadKey: &identity,
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	resource.Status = model.ResourceStatusReady
	if err := repo.SaveResource(resource); err != nil {
		t.Fatal(err)
	}
	row, err := repo.UploadReservation("user-1", identity)
	if err != nil || row != nil {
		t.Fatalf("witness leftover %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", "2026-10-02")
	if err != nil || usage != 7 {
		t.Fatalf("daily=%d err=%v", usage, err)
	}
}

func TestSaveResourceFailedReleasesWitness(t *testing.T) {
	repo := newUploadReservationRepo(t)
	identity := "failed-id"
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", identity, 7, 1000); err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{
		ID: "res-failed", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/b.png", Size: 7, UploadKey: &identity,
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	resource.Status = model.ResourceStatusFailed
	resource.Error = "write failed"
	if err := repo.SaveResource(resource); err != nil {
		t.Fatal(err)
	}
	row, err := repo.UploadReservation("user-1", identity)
	if err != nil || row != nil {
		t.Fatalf("witness leftover %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", "2026-10-02")
	if err != nil || usage != 0 {
		t.Fatalf("daily=%d err=%v", usage, err)
	}
}

func TestDeleteReadyResourceDoesNotRefundDaily(t *testing.T) {
	repo := newUploadReservationRepo(t)
	identity := "delete-ready"
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", identity, 7, 1000); err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{
		ID: "res-delete", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/c.png", Size: 7, UploadKey: &identity,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteResource("user-1", resource.ID); err != nil {
		t.Fatal(err)
	}
	row, err := repo.UploadReservation("user-1", identity)
	if err != nil || row != nil {
		t.Fatalf("witness leftover %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", "2026-10-02")
	if err != nil || usage != 7 {
		t.Fatalf("delete refunded daily=%d err=%v", usage, err)
	}
}

func TestClaimFailedResourceUploadKeepsHeldWitness(t *testing.T) {
	repo := newUploadReservationRepo(t)
	identity := "failed-retry"
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", identity, 7, 1000); err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{
		ID: "res-failed-retry", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/d.png", Size: 7, UploadKey: &identity,
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	claimed, err := repo.ClaimFailedResourceUpload("user-1", resource.ID)
	if err != nil || !claimed {
		t.Fatalf("claim leftover FAILED claimed=%v err=%v", claimed, err)
	}
	row, err := repo.UploadReservation("user-1", identity)
	if err != nil || row == nil {
		t.Fatalf("claim released leftover witness %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", "2026-10-02")
	if err != nil || usage != 7 {
		t.Fatalf("claim daily=%d err=%v", usage, err)
	}
	err = repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", identity, 7, 1000)
	if !errors.Is(err, ErrUploadReservationConflict) {
		t.Fatalf("leftover claim re-reserve err=%v", err)
	}
}

func TestDeleteResourceWithoutReservationTableFails(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "no-witness.db")+"?_busy_timeout=5000&_foreign_keys=on"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Resource{}); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	resource := &model.Resource{
		ID: "res-no-table", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/e.png", Size: 7,
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteResource("user-1", resource.ID); err == nil {
		t.Fatal("missing user_upload_reservations succeeded")
	}
}

func TestClaimFailedThenReserveAfterReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reopen.db")
	open := func() *Repository {
		t.Helper()
		db, err := gorm.Open(sqlite.Open(path+"?_busy_timeout=5000&_foreign_keys=on"), &gorm.Config{})
		if err != nil {
			t.Fatal(err)
		}
		if err := db.AutoMigrate(&model.Resource{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{}); err != nil {
			t.Fatal(err)
		}
		return New(db)
	}
	repo := open()
	identity := "reopen-failed"
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", identity, 7, 1000); err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{
		ID: "res-reopen-failed", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/f.png", Size: 7, UploadKey: &identity,
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	sqlDB, err := repo.DB().DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}

	repo = open()
	claimed, err := repo.ClaimFailedResourceUpload("user-1", resource.ID)
	if err != nil || !claimed {
		t.Fatalf("reopen claim claimed=%v err=%v", claimed, err)
	}
	row, err := repo.UploadReservation("user-1", identity)
	if err != nil || row == nil {
		t.Fatalf("reopen claim released leftover %#v err=%v", row, err)
	}
	err = repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", identity, 7, 1000)
	if !errors.Is(err, ErrUploadReservationConflict) {
		t.Fatalf("reopen leftover re-reserve err=%v", err)
	}
}

func TestClaimFailedSettledThenReserveAfterReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reopen-settled.db")
	open := func() *Repository {
		t.Helper()
		db, err := gorm.Open(sqlite.Open(path+"?_busy_timeout=5000&_foreign_keys=on"), &gorm.Config{})
		if err != nil {
			t.Fatal(err)
		}
		if err := db.AutoMigrate(&model.Resource{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{}); err != nil {
			t.Fatal(err)
		}
		return New(db)
	}
	repo := open()
	identity := "reopen-settled"
	resource := &model.Resource{
		ID: "res-reopen-settled", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/g.png", Size: 7, UploadKey: &identity,
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	claimed, err := repo.ClaimFailedResourceUpload("user-1", resource.ID)
	if err != nil || !claimed {
		t.Fatalf("settled claim claimed=%v err=%v", claimed, err)
	}
	sqlDB, err := repo.DB().DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}

	repo = open()
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", identity, 7, 1000); err != nil {
		t.Fatalf("settled claim-crash reserve: %v", err)
	}
	usage, err := repo.DailyUploadBytes("user-1", "2026-10-02")
	if err != nil || usage != 7 {
		t.Fatalf("settled claim-crash daily=%d err=%v", usage, err)
	}
}

func TestSaveResourceFailedKeepsUnattributedMarker(t *testing.T) {
	repo := newUploadReservationRepo(t)
	identity := "unattributed-failed"
	now := time.Now()
	day := now.UTC().Format("2006-01-02")
	if err := repo.DB().Create(&model.UserDailyUploadUsage{
		ID: "user-1:" + day, UserID: "user-1", Day: day, Bytes: 7, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DB().Create(&model.UserUploadReservation{
		ID: "user-1:" + identity, UserID: "user-1", Identity: identity,
		Day: model.UploadReservationUnattributedDay, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{
		ID: "res-unattributed-failed", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/u.png", Size: 7, UploadKey: &identity,
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	resource.Status = model.ResourceStatusFailed
	resource.Error = "write failed"
	if err := repo.SaveResource(resource); err != nil {
		t.Fatal(err)
	}
	row, err := repo.UploadReservation("user-1", identity)
	if err != nil || row == nil || !row.Unattributed() {
		t.Fatalf("SaveFailed cleared sentinel %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("SaveFailed daily=%d err=%v", usage, err)
	}
}

func TestClaimFailedKeepsUnattributedMarker(t *testing.T) {
	repo := newUploadReservationRepo(t)
	identity := "unattributed-claim"
	now := time.Now()
	if err := repo.DB().Create(&model.UserUploadReservation{
		ID: "user-1:" + identity, UserID: "user-1", Identity: identity,
		Day: model.UploadReservationUnattributedDay, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{
		ID: "res-unattributed-claim", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/c.png", Size: 7, UploadKey: &identity,
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	claimed, err := repo.ClaimFailedResourceUpload("user-1", resource.ID)
	if err != nil || !claimed {
		t.Fatalf("claim claimed=%v err=%v", claimed, err)
	}
	row, err := repo.UploadReservation("user-1", identity)
	if err != nil || row == nil || !row.Unattributed() {
		t.Fatalf("claim cleared sentinel %#v err=%v", row, err)
	}
}

func TestReleaseUnattributedIsNoop(t *testing.T) {
	repo := newUploadReservationRepo(t)
	identity := "unattributed-release"
	now := time.Now()
	day := now.UTC().Format("2006-01-02")
	if err := repo.DB().Create(&model.UserDailyUploadUsage{
		ID: "user-1:" + day, UserID: "user-1", Day: day, Bytes: 7, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DB().Create(&model.UserUploadReservation{
		ID: "user-1:" + identity, UserID: "user-1", Identity: identity,
		Day: model.UploadReservationUnattributedDay, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.ReleaseIdentifiedDailyUpload("user-1", day, identity, 7); err != nil {
		t.Fatal(err)
	}
	row, err := repo.UploadReservation("user-1", identity)
	if err != nil || row == nil || !row.Unattributed() {
		t.Fatalf("release cleared sentinel %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("release daily=%d err=%v", usage, err)
	}
}

func TestDeleteUnattributedClearsMarkerWithoutRefund(t *testing.T) {
	repo := newUploadReservationRepo(t)
	identity := "unattributed-delete"
	now := time.Now()
	day := now.UTC().Format("2006-01-02")
	if err := repo.DB().Create(&model.UserDailyUploadUsage{
		ID: "user-1:" + day, UserID: "user-1", Day: day, Bytes: 7, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DB().Create(&model.UserUploadReservation{
		ID: "user-1:" + identity, UserID: "user-1", Identity: identity,
		Day: model.UploadReservationUnattributedDay, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{
		ID: "res-unattributed-delete", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/d.png", Size: 7, UploadKey: &identity,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteResource("user-1", resource.ID); err != nil {
		t.Fatal(err)
	}
	row, err := repo.UploadReservation("user-1", identity)
	if err != nil || row != nil {
		t.Fatalf("delete left sentinel %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("delete refunded daily=%d err=%v", usage, err)
	}
}

func TestReleaseIdentifiedDailyUploadMissingRowIsNoop(t *testing.T) {
	repo := newUploadReservationRepo(t)
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", "held", 11, 1000); err != nil {
		t.Fatal(err)
	}
	if err := repo.ReleaseIdentifiedDailyUpload("user-1", "2026-10-02", "missing", 11); err != nil {
		t.Fatal(err)
	}
	usage, err := repo.DailyUploadBytes("user-1", "2026-10-02")
	if err != nil || usage != 11 {
		t.Fatalf("missing identity released other daily=%d err=%v", usage, err)
	}
}
