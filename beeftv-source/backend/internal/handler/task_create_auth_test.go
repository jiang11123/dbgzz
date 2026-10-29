package handler

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
)

func TestRegisteredClientCannotCreatePaidTasksWithDesktopHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "task-create-auth.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	service := app.NewLocal(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = service.Close() })
	trust := func(r *http.Request) bool {
		return r.Header.Get("X-Desktop-Token") == "launch" && r.Header.Get("X-Beeftv-UI-Bootstrap") == "ui"
	}
	capture := &captureTaskPort{}
	deps := defaultRuntimeDependencies(service)
	deps.DesktopTrust = trust
	deps.Tasks = capture
	deps.Generation = capture
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(deps))
	RegisterTaskRoutes(router.Group("/api"), service)

	clients := agentops.NewClientRegistry(t.TempDir())
	reg, token, err := clients.RegisterKind("codex", "codex", agentops.ClientReadWrite)
	if err != nil {
		t.Fatal(err)
	}
	agentHeaders := map[string]string{
		"X-Beeftv-Client": reg.ID, "Authorization": "Bearer " + token,
	}
	stolenDesktop := map[string]string{
		"X-Beeftv-Client": reg.ID, "Authorization": "Bearer " + token,
		"X-Desktop-Token": "launch", "X-Beeftv-UI-Bootstrap": "ui",
	}
	trustedUI := map[string]string{
		"X-Desktop-Token": "launch", "X-Beeftv-UI-Bootstrap": "ui",
	}

	visible := true
	renderBody, err := json.Marshal(localtask.TimelineRenderCreateRequest{
		ProjectID:         "prj-1",
		ClientOperationID: "timeline:auth-render",
		Timeline: editing.Project{
			Version: 2, DurationMs: 2000,
			Tracks: []editing.Track{{ID: "v", Kind: "video", Visible: &visible}},
			Clips: []editing.Clip{{
				ID: "v", Kind: "video", TrackID: "v", DurationMs: 2000, Volume: 1,
				DirectMedia: &editing.DirectMedia{ID: "v", Kind: "video", StorageKey: "resource:res-1"},
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	transBody, err := json.Marshal(localtask.TimelineTranscriptionCreateRequest{
		ResourceID: "res-1", Language: "zh", ProjectID: "prj-1", ClientOperationID: "timeline:auth-trans",
	})
	if err != nil {
		t.Fatal(err)
	}
	depthBody, err := json.Marshal(localtask.DepthCaptureCreateRequest{
		ProjectID: "prj-1", ResourceID: "res-1", ClientOperationID: "depth:auth-1",
	})
	if err != nil {
		t.Fatal(err)
	}

	probes := []struct {
		path    string
		body    string
		message string
	}{
		{"/api/tasks", `{"type":"canvas_text","prompt":"手工写一段分镜"}`, "任务只能由当前桌面界面创建"},
		{"/api/timeline/renders", string(renderBody), "时间线渲染只能由当前桌面界面创建"},
		{"/api/timeline/transcriptions", string(transBody), "字幕转写只能由当前桌面界面创建"},
		{"/api/depth-captures", string(depthBody), "深度捕捉只能由当前桌面界面创建"},
	}

	assertForbidden := func(t *testing.T, headers map[string]string, probe struct {
		path    string
		body    string
		message string
	}, label string) {
		t.Helper()
		recorder := creationAuthCall(t, router, http.MethodPost, probe.path, headers, probe.body)
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("%s %s: status=%d body=%s", label, probe.path, recorder.Code, recorder.Body.String())
		}
		if !strings.Contains(recorder.Body.String(), probe.message) {
			t.Fatalf("%s %s: missing product message %q in %s", label, probe.path, probe.message, recorder.Body.String())
		}
	}

	for _, probe := range probes {
		assertForbidden(t, agentHeaders, probe, "agent token")
		assertForbidden(t, stolenDesktop, probe, "agent plus desktop headers")
		assertForbidden(t, map[string]string{"X-Desktop-Token": "launch"}, probe, "launch token without UI bootstrap")
	}
	if capture.gen.Prompt != "" || capture.render.ProjectID != "" || capture.trans.ResourceID != "" || capture.depth.ResourceID != "" {
		t.Fatalf("forbidden callers reached task admission: gen=%+v render=%+v trans=%+v depth=%+v", capture.gen, capture.render, capture.trans, capture.depth)
	}

	for _, probe := range probes {
		created := creationAuthCall(t, router, http.MethodPost, probe.path, trustedUI, probe.body)
		if created.Code != http.StatusOK {
			t.Fatalf("trusted desktop UI should create %s: %d %s", probe.path, created.Code, created.Body.String())
		}
	}
	if capture.gen.Prompt != "手工写一段分镜" || capture.render.ClientOperationID != "timeline:auth-render" || capture.trans.ClientOperationID != "timeline:auth-trans" || capture.depth.ClientOperationID != "depth:auth-1" {
		t.Fatalf("trusted UI did not reach admission: gen=%+v render=%+v trans=%+v depth=%+v", capture.gen, capture.render, capture.trans, capture.depth)
	}

	listed := creationAuthCall(t, router, http.MethodGet, "/api/tasks", agentHeaders, "")
	if listed.Code == http.StatusForbidden {
		t.Fatalf("ordinary task list must remain distinct from create: %s", listed.Body.String())
	}
	canceled := creationAuthCall(t, router, http.MethodPost, "/api/tasks/missing/cancel", stolenDesktop, "{}")
	if canceled.Code == http.StatusForbidden {
		t.Fatalf("ordinary task cancel must remain distinct from create: %s", canceled.Body.String())
	}
}

func TestHostedTaskCreateStillAllowsWorkspaceOwnerWithoutDesktopTrust(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "task-create-hosted.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	service := app.NewLocal(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = service.Close() })
	capture := &captureTaskPort{}
	deps := defaultRuntimeDependencies(service)
	deps.Tasks = capture
	deps.Generation = capture
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(deps))
	RegisterTaskRoutes(router.Group("/api"), service)

	created := creationAuthCall(t, router, http.MethodPost, "/api/tasks", nil, `{"type":"canvas_text","prompt":"托管所有者创建"}`)
	if created.Code != http.StatusOK {
		t.Fatalf("hosted owner create should succeed when DesktopTrust is unset: %d %s", created.Code, created.Body.String())
	}
	if capture.gen.Type != "canvas_text" || capture.gen.Prompt != "托管所有者创建" {
		t.Fatalf("hosted owner did not reach admission: %+v", capture.gen)
	}
}

func TestRegisteredClientCannotRetryPaidTasksWithDesktopHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "task-retry-auth.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	service := app.NewLocal(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = service.Close() })
	owner, err := service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	seedRetryableFailedTask(t, db, owner.ID, "retry-auth-1")
	trust := func(r *http.Request) bool {
		return r.Header.Get("X-Desktop-Token") == "launch" && r.Header.Get("X-Beeftv-UI-Bootstrap") == "ui"
	}
	deps := defaultRuntimeDependencies(service)
	deps.DesktopTrust = trust
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(deps))
	RegisterTaskRoutes(router.Group("/api"), service)

	clients := agentops.NewClientRegistry(t.TempDir())
	reg, token, err := clients.RegisterKind("codex", "codex", agentops.ClientReadWrite)
	if err != nil {
		t.Fatal(err)
	}
	agentHeaders := map[string]string{
		"X-Beeftv-Client": reg.ID, "Authorization": "Bearer " + token,
	}
	stolenDesktop := map[string]string{
		"X-Beeftv-Client": reg.ID, "Authorization": "Bearer " + token,
		"X-Desktop-Token": "launch", "X-Beeftv-UI-Bootstrap": "ui",
	}
	path := "/api/tasks/retry-auth-1/retry"
	message := "任务只能由当前桌面界面重试"
	for _, probe := range []struct {
		label   string
		headers map[string]string
	}{
		{"agent token", agentHeaders},
		{"agent plus desktop headers", stolenDesktop},
		{"launch token without UI bootstrap", map[string]string{"X-Desktop-Token": "launch"}},
	} {
		recorder := creationAuthCall(t, router, http.MethodPost, path, probe.headers, "{}")
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("%s: status=%d body=%s", probe.label, recorder.Code, recorder.Body.String())
		}
		if !strings.Contains(recorder.Body.String(), message) {
			t.Fatalf("%s: missing product message %q in %s", probe.label, message, recorder.Body.String())
		}
	}
	blocked := loadTask(t, db, "retry-auth-1")
	if blocked.Status != model.TaskStatusFailed || blocked.Error != "请求过于频繁" || blocked.RouteRun != 0 {
		t.Fatalf("forbidden callers retried the task: status=%s error=%q routeRun=%d", blocked.Status, blocked.Error, blocked.RouteRun)
	}

	retried := creationAuthCall(t, router, http.MethodPost, path, map[string]string{
		"X-Desktop-Token": "launch", "X-Beeftv-UI-Bootstrap": "ui",
	}, "{}")
	if retried.Code != http.StatusOK {
		t.Fatalf("trusted desktop UI should retry: %d %s", retried.Code, retried.Body.String())
	}
	queued := loadTask(t, db, "retry-auth-1")
	if queued.Status != model.TaskStatusQueued || queued.RouteRun != 1 {
		t.Fatalf("trusted UI retry did not requeue: status=%s routeRun=%d", queued.Status, queued.RouteRun)
	}

	canceled := creationAuthCall(t, router, http.MethodPost, "/api/tasks/retry-auth-1/cancel", stolenDesktop, "{}")
	if canceled.Code == http.StatusForbidden {
		t.Fatalf("ordinary task cancel must remain distinct from retry: %s", canceled.Body.String())
	}
}

func TestHostedTaskRetryStillAllowsWorkspaceOwnerWithoutDesktopTrust(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "task-retry-hosted.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	service := app.NewLocal(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = service.Close() })
	owner, err := service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	seedRetryableFailedTask(t, db, owner.ID, "retry-hosted-1")
	deps := defaultRuntimeDependencies(service)
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(deps))
	RegisterTaskRoutes(router.Group("/api"), service)

	retried := creationAuthCall(t, router, http.MethodPost, "/api/tasks/retry-hosted-1/retry", nil, "{}")
	if retried.Code != http.StatusOK {
		t.Fatalf("hosted owner retry should succeed when DesktopTrust is unset: %d %s", retried.Code, retried.Body.String())
	}
	queued := loadTask(t, db, "retry-hosted-1")
	if queued.Status != model.TaskStatusQueued || queued.RouteRun != 1 {
		t.Fatalf("hosted owner retry did not requeue: status=%s routeRun=%d", queued.Status, queued.RouteRun)
	}
}

func seedRetryableFailedTask(t *testing.T, db *gorm.DB, userID, id string) {
	t.Helper()
	task := model.Task{
		ID: id, UserID: userID, Type: "canvas_text",
		Status: model.TaskStatusFailed, Stage: "任务失败", Error: "请求过于频繁",
		Prompt:    "手工写一段分镜",
		InputJSON: `{"mode":"text","prompt":"手工写一段分镜","config":{"channelId":"channel","model":"text-test"}}`,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
}

func loadTask(t *testing.T, db *gorm.DB, id string) model.Task {
	t.Helper()
	var stored model.Task
	if err := db.First(&stored, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	return stored
}
