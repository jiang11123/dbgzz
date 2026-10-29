package repository

import (
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newPlaybackRepo(t *testing.T) *Repository {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "playback.db")), &gorm.Config{})
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
	return New(db)
}

func TestFinishPlaybackTranscodeRequiresProcessingAndReady(t *testing.T) {
	repo := newPlaybackRepo(t)
	ready := model.Resource{
		ID: "r-ready", UserID: "u1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", PlaybackStatus: model.PlaybackStatusProcessing,
	}
	pending := ready
	pending.ID = "r-pending"
	pending.Status = model.ResourceStatusPending
	if err := repo.CreateResource(&ready); err != nil {
		t.Fatal(err)
	}
	if err := repo.CreateResource(&pending); err != nil {
		t.Fatal(err)
	}

	ok, err := repo.FinishPlaybackTranscode("r-ready", model.PlaybackStatusReady, "r-ready.mp4", "")
	if err != nil || !ok {
		t.Fatalf("ready processing row: ok=%v err=%v", ok, err)
	}
	ok, err = repo.FinishPlaybackTranscode("r-pending", model.PlaybackStatusReady, "r-pending.mp4", "")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("non-READY row accepted a playback READY write")
	}
	got, err := repo.Resource("r-pending")
	if err != nil {
		t.Fatal(err)
	}
	if got.PlaybackStatus != model.PlaybackStatusProcessing || got.PlaybackObjectKey != "" {
		t.Fatalf("pending row mutated: %+v", got)
	}
}

func TestClaimPlaybackTranscodeRequiresReady(t *testing.T) {
	repo := newPlaybackRepo(t)
	pending := model.Resource{
		ID: "r-pending", UserID: "u1", Kind: "video", Status: model.ResourceStatusPending,
		Provider: "local", PlaybackStatus: "",
	}
	ready := pending
	ready.ID = "r-ready"
	ready.Status = model.ResourceStatusReady
	if err := repo.CreateResource(&pending); err != nil {
		t.Fatal(err)
	}
	if err := repo.CreateResource(&ready); err != nil {
		t.Fatal(err)
	}
	ok, err := repo.ClaimPlaybackTranscode("r-pending")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("claimed a non-READY row")
	}
	ok, err = repo.ClaimPlaybackTranscode("r-ready")
	if err != nil || !ok {
		t.Fatalf("ready claim: ok=%v err=%v", ok, err)
	}
}

func TestFinishPlaybackTranscodeDoesNotResurrectDeleted(t *testing.T) {
	repo := newPlaybackRepo(t)
	res := model.Resource{
		ID: "r-del", UserID: "u1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", PlaybackStatus: model.PlaybackStatusProcessing,
	}
	if err := repo.CreateResource(&res); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteResource("u1", "r-del"); err != nil {
		t.Fatal(err)
	}
	ok, err := repo.FinishPlaybackTranscode("r-del", model.PlaybackStatusReady, "r-del.mp4", "")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("finish resurrected a deleted row")
	}
	if _, err := repo.Resource("r-del"); err == nil {
		t.Fatal("deleted row still present")
	}
}

func TestReleasePlaybackTranscodeClaimRequiresReady(t *testing.T) {
	repo := newPlaybackRepo(t)
	res := model.Resource{
		ID: "r-pending", UserID: "u1", Kind: "video", Status: model.ResourceStatusPending,
		Provider: "local", PlaybackStatus: model.PlaybackStatusProcessing,
	}
	if err := repo.CreateResource(&res); err != nil {
		t.Fatal(err)
	}
	if err := repo.ReleasePlaybackTranscodeClaim("r-pending"); err != nil {
		t.Fatal(err)
	}
	got, err := repo.Resource("r-pending")
	if err != nil {
		t.Fatal(err)
	}
	if got.PlaybackStatus != model.PlaybackStatusProcessing {
		t.Fatalf("non-READY claim was reset: %q", got.PlaybackStatus)
	}
}
