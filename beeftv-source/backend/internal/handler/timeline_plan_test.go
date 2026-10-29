package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestTimelineRenderPlanIsAuthenticatedAndSideEffectFree(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "plan.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "local", Name: "本地工作区"}).Error; err != nil {
		t.Fatal(err)
	}
	svc := app.NewLocal(repository.New(db), t.TempDir())
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: t.TempDir()}))
	router.Use(RuntimeDependenciesMiddleware(defaultRuntimeDependencies(svc)))
	RegisterTaskRoutes(router.Group("/api"), svc)

	trueVal := true
	body, _ := json.Marshal(app.TimelineRenderPlanRequest{
		Timeline: editing.Project{
			Version:    2,
			DurationMs: 2000,
			Tracks:     []editing.Track{{ID: "v"}},
			Clips: []editing.Clip{{
				ID: "v", Kind: "video", NodeID: "node-v", TrackID: "v", DurationMs: 2000, Volume: 1,
				DirectMedia: &editing.DirectMedia{ID: "v", Kind: "video", StorageKey: "resource:v"},
			}},
		},
		Sources: []editing.SourceMeta{{ID: "node-v", HasAudio: &trueVal, HasVideo: &trueVal, DurationMs: 4000}},
	})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/timeline/render-plan", bytes.NewReader(body)))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "/tmp") || strings.Contains(recorder.Body.String(), "ffmpeg") {
		t.Fatalf("plan leaked path or ffmpeg args: %s", recorder.Body.String())
	}
	var envelope struct {
		Code int          `json:"code"`
		Data editing.Plan `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Code != 0 || envelope.Data.Version != editing.PlanVersion || len(envelope.Data.Segments) != 1 {
		t.Fatalf("plan=%+v", envelope)
	}

	overlap, _ := json.Marshal(app.TimelineRenderPlanRequest{
		Timeline: editing.Project{
			Version: 2,
			Tracks:  []editing.Track{{ID: "v"}},
			Clips: []editing.Clip{
				{ID: "a", Kind: "video", NodeID: "a", TrackID: "v", DurationMs: 2000, Volume: 1, DirectMedia: &editing.DirectMedia{StorageKey: "resource:a"}},
				{ID: "b", Kind: "video", NodeID: "b", TrackID: "v", StartMs: 1000, DurationMs: 1000, Volume: 1, DirectMedia: &editing.DirectMedia{StorageKey: "resource:b"}},
			},
		},
		Sources: []editing.SourceMeta{{ID: "a", DurationMs: 5000}, {ID: "b", DurationMs: 5000}},
	})
	fail := httptest.NewRecorder()
	router.ServeHTTP(fail, httptest.NewRequest(http.MethodPost, "/api/timeline/render-plan", bytes.NewReader(overlap)))
	if fail.Code != http.StatusBadRequest || !strings.Contains(fail.Body.String(), "重叠") {
		t.Fatalf("overlap status=%d body=%s", fail.Code, fail.Body.String())
	}

	var tasks int64
	if err := db.Model(&model.Task{}).Count(&tasks).Error; err != nil || tasks != 0 {
		t.Fatalf("planning queued a task: %d %v", tasks, err)
	}
}

func TestTimelineRenderPlanRejectsAnonymousWhenWorkspaceMissing(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterTaskRoutes(router.Group("/api"), app.NewLocal(nil, t.TempDir()))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/timeline/render-plan", bytes.NewBufferString(`{"timeline":{}}`)))
	if recorder.Code == http.StatusOK {
		t.Fatalf("uninitialized workspace accepted plan: %s", recorder.Body.String())
	}
}
