package canvas

import (
	"encoding/json"
	"errors"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/repository"
	"net/http"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func TestCanvasSaveRevisionContract(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	actor := &model.User{ID: "owner"}
	missing := json.RawMessage(`{"id":"canvas","nodes":[]}`)
	_, err := svc.UpsertUserCanvasProject(actor.ID, missing)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusPreconditionRequired {
		t.Fatalf("unversioned save = %v", err)
	}
	raw := json.RawMessage(`{"id":"canvas","revision":0,"title":"initial","nodes":[{"id":"old"}],"viewport":{"x":999,"y":0,"k":2}}`)
	created, err := svc.UpsertUserCanvasProject(actor.ID, raw)
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 1 {
		t.Fatalf("revision = %d", created.Revision)
	}
	update := json.RawMessage(`{"id":"canvas","revision":1,"title":"new","nodes":[{"id":"old"},{"id":"video"}],"updatedAt":"2099-01-01T00:00:00Z","remoteContentHash":"local-only","viewport":{"x":500,"y":10,"k":3}}`)
	saved, err := svc.UpsertUserCanvasProject(actor.ID, update)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 2 || saved.UpdatedAt.Year() == 2099 {
		t.Fatalf("invalid server metadata: %#v", saved)
	}
	_, err = svc.UpsertUserCanvasProject(actor.ID, update)
	if !errors.As(err, &appError) || appError.Status != http.StatusConflict {
		t.Fatalf("stale save = %v", err)
	}
	got, err := svc.UserCanvasProject(actor.ID, "canvas")
	if err != nil {
		t.Fatal(err)
	}
	var project map[string]any
	if err := json.Unmarshal(got, &project); err != nil {
		t.Fatal(err)
	}
	if project["revision"] != float64(2) || len(project["nodes"].([]any)) != 2 {
		t.Fatalf("read lost metadata/content: %s", got)
	}
	if project["remoteContentHash"] != nil || project["viewport"].(map[string]any)["x"] != float64(0) {
		t.Fatalf("content save persisted local preferences: %s", got)
	}
	if _, err := svc.UserCanvasProject("unrelated", "canvas"); err == nil {
		t.Fatal("unrelated user could read canvas")
	}
}

func TestCanvasProjectPersistsTimelineRoundTrip(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	raw := json.RawMessage(`{
		"id":"canvas",
		"revision":0,
		"title":"验收画布",
		"nodes":[{"id":"7vvfM674HnenwTekmj88V","type":"audio"}],
		"connections":[],
		"timeline":{
			"version":2,
			"durationMs":5600,
			"tracks":[
				{"id":"video-1","kind":"video","label":"视频 1","order":0},
				{"id":"audio-1","kind":"audio","label":"音频 1","order":1},
				{"id":"subtitle-1","kind":"subtitle","label":"字幕 1","order":2}
			],
			"clips":[{
				"id":"clip-audio-1",
				"kind":"audio",
				"nodeId":"7vvfM674HnenwTekmj88V",
				"trackId":"audio-1",
				"startMs":0,
				"durationMs":5600,
				"title":"旁白"
			}]
		}
	}`)
	if _, err := svc.UpsertUserCanvasProject("owner", raw); err != nil {
		t.Fatal(err)
	}
	got, err := svc.UserCanvasProject("owner", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	var project struct {
		Timeline struct {
			DurationMs float64 `json:"durationMs"`
			Tracks     []struct {
				ID   string `json:"id"`
				Kind string `json:"kind"`
			} `json:"tracks"`
			Clips []struct {
				ID         string  `json:"id"`
				Kind       string  `json:"kind"`
				NodeID     string  `json:"nodeId"`
				TrackID    string  `json:"trackId"`
				StartMs    float64 `json:"startMs"`
				DurationMs float64 `json:"durationMs"`
			} `json:"clips"`
		} `json:"timeline"`
	}
	if err := json.Unmarshal(got, &project); err != nil {
		t.Fatal(err)
	}
	if project.Timeline.DurationMs != 5600 {
		t.Fatalf("durationMs = %v", project.Timeline.DurationMs)
	}
	if len(project.Timeline.Tracks) != 3 {
		t.Fatalf("tracks = %#v", project.Timeline.Tracks)
	}
	if project.Timeline.Tracks[0].Kind != "video" || project.Timeline.Tracks[1].Kind != "audio" || project.Timeline.Tracks[2].Kind != "subtitle" {
		t.Fatalf("track kinds = %#v", project.Timeline.Tracks)
	}
	if len(project.Timeline.Clips) != 1 {
		t.Fatalf("clips = %#v", project.Timeline.Clips)
	}
	clip := project.Timeline.Clips[0]
	if clip.ID != "clip-audio-1" || clip.Kind != "audio" || clip.NodeID != "7vvfM674HnenwTekmj88V" || clip.TrackID != "audio-1" || clip.StartMs != 0 || clip.DurationMs != 5600 {
		t.Fatalf("clip = %#v", clip)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(got, &payload); err != nil {
		t.Fatal(err)
	}
	if _, ok := payload["timeline"]; !ok {
		t.Fatalf("payload keys missing timeline: %s", got)
	}
}

func newCanvasHistoryTestService(t *testing.T) *Service {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "canvas.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&model.CanvasProject{}, &model.CanvasSnapshot{}, &model.CanvasSnapshotResource{}, &model.CanvasUnitLink{},
		&model.Resource{}, &model.Asset{}, &model.AssetVersion{}, &model.AssetRepresentation{}, &model.AssetFolder{},
		&model.CanvasLibraryFolder{}, &model.CanvasDrawing{},
		&model.AgentOpRecord{},
		&model.Task{}, &model.TaskLog{}, &model.Result{}, &model.TaskTextDelta{}, &model.ApiCallLog{},
		&model.CreationRun{}, &model.CreationSubmission{},
		&model.Project{}, &model.StyleProfile{}, &model.VoiceProfile{},
		&model.Shot{}, &model.ShotArtifact{}, &model.ShotAssetReference{},
		&model.ProjectAssetCandidate{}, &model.ProjectAssetLink{},
		&model.WorkflowInstance{}, &model.WorkflowStepInstance{},
		&model.CharacterVoiceBinding{}, &model.ArkPrivateAssetBinding{},
	); err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	return New(repository.New(db), nil)
}

func newCanvasLibraryTestPair(t *testing.T) (*Service, *Service, *gorm.DB) {
	t.Helper()
	svc := newCanvasHistoryTestService(t)
	return svc, New(svc.repo, nil), svc.repo.DB()
}

func migrateUploadSettlementTables(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := db.AutoMigrate(&model.UserDailyUploadUsage{}, &model.UserUploadReservation{}); err != nil {
		t.Fatal(err)
	}
}

func mustOpenSQLite(t *testing.T, path string) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	return db
}
