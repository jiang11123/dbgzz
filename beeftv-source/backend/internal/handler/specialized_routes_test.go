package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type captureTaskPort struct {
	mu     sync.Mutex
	userID string
	render localtask.TimelineRenderCreateRequest
	trans  localtask.TimelineTranscriptionCreateRequest
	depth  localtask.DepthCaptureCreateRequest
	gen    localtask.CreateRequest
}

func (c *captureTaskPort) TasksWithOptions(string, localtask.ListOptions) ([]localtask.Summary, error) {
	return nil, nil
}

func (c *captureTaskPort) CreateTimelineRenderTask(userID string, req localtask.TimelineRenderCreateRequest) (*model.Task, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.userID = userID
	c.render = req
	return &model.Task{ID: "render-1", Type: model.TaskTypeTimelineRender, Status: model.TaskStatusQueued}, nil
}

func (c *captureTaskPort) CreateTimelineTranscriptionTask(userID string, req localtask.TimelineTranscriptionCreateRequest) (*model.Task, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.userID = userID
	c.trans = req
	return &model.Task{ID: "trans-1", Type: model.TaskTypeTimelineTranscription, Status: model.TaskStatusQueued}, nil
}

func (c *captureTaskPort) CreateDepthCaptureTask(userID string, req localtask.DepthCaptureCreateRequest) (*model.Task, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.userID = userID
	c.depth = req
	return &model.Task{ID: "depth-1", Type: model.TaskTypeDepthCapture, Status: model.TaskStatusQueued}, nil
}

func (c *captureTaskPort) CreateTask(userID string, req localtask.CreateRequest) (*model.Task, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.userID = userID
	c.gen = req
	return &model.Task{ID: "gen-1", Type: req.Type, Status: model.TaskStatusQueued}, nil
}

func TestSpecializedRoutesBindLocalExecutorRequests(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "specialized-routes.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := app.NewLocal(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = svc.Close() })
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	capture := &captureTaskPort{}
	deps := defaultRuntimeDependencies(svc)
	deps.Tasks = capture
	deps.Generation = capture
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: owner.ID, DataDir: t.TempDir()}))
	router.Use(RuntimeDependenciesMiddleware(deps))
	RegisterTaskRoutes(router.Group("/api"), svc)

	visible := true
	renderBody, _ := json.Marshal(localtask.TimelineRenderCreateRequest{
		ProjectID:         "prj-1",
		ClientOperationID: "timeline:http-render",
		Timeline: editing.Project{
			Version: 2, DurationMs: 2000,
			Tracks: []editing.Track{{ID: "v", Kind: "video", Visible: &visible}},
			Clips: []editing.Clip{{
				ID: "v", Kind: "video", TrackID: "v", DurationMs: 2000, Volume: 1,
				DirectMedia: &editing.DirectMedia{ID: "v", Kind: "video", StorageKey: "resource:res-1"},
			}},
		},
	})
	postJSON(t, router, "/api/timeline/renders", renderBody)
	if capture.render.ProjectID != "prj-1" || capture.render.ClientOperationID != "timeline:http-render" || capture.userID != owner.ID {
		t.Fatalf("render bound = %+v user=%s", capture.render, capture.userID)
	}

	transBody, _ := json.Marshal(localtask.TimelineTranscriptionCreateRequest{
		ResourceID: "res-1", Language: "zh", ProjectID: "prj-1", ClientOperationID: "timeline:http-trans",
	})
	postJSON(t, router, "/api/timeline/transcriptions", transBody)
	if capture.trans.ResourceID != "res-1" || capture.trans.ClientOperationID != "timeline:http-trans" {
		t.Fatalf("transcription bound = %+v", capture.trans)
	}

	depthBody, _ := json.Marshal(localtask.DepthCaptureCreateRequest{
		ProjectID: "prj-1", ResourceID: "res-1", ClientOperationID: "depth:http-1",
	})
	postJSON(t, router, "/api/depth-captures", depthBody)
	if capture.depth.ResourceID != "res-1" || capture.depth.ClientOperationID != "depth:http-1" {
		t.Fatalf("depth bound = %+v", capture.depth)
	}

	genBody, _ := json.Marshal(localtask.CreateRequest{Type: model.TaskTypeTimelineRender, Prompt: "时间线渲染"})
	postJSON(t, router, "/api/tasks", genBody)
	if capture.gen.Type != model.TaskTypeTimelineRender || capture.gen.Prompt != "时间线渲染" {
		t.Fatalf("generation bound = %+v", capture.gen)
	}
	if capture.render.Timeline.Clips[0].DirectMedia == nil {
		t.Fatal("render timeline was not bound")
	}
}

func postJSON(t *testing.T, router *gin.Engine, path string, body []byte) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("%s status=%d body=%s", path, recorder.Code, recorder.Body.String())
	}
}
