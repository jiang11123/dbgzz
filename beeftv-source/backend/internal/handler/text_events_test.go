package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/textreplay"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestTaskTextEventCursorPrefersQueryAndSupportsLastEventID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	request := httptest.NewRequest("GET", "/api/tasks/task-1/text-events?after=7", nil)
	request.Header.Set("Last-Event-ID", "3")
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = request
	after, err := taskTextEventCursor(context)
	if err != nil || after != 7 {
		t.Fatalf("cursor = %d, err = %v", after, err)
	}

	request = httptest.NewRequest("GET", "/api/tasks/task-1/text-events", nil)
	request.Header.Set("Last-Event-ID", "3")
	context, _ = gin.CreateTestContext(httptest.NewRecorder())
	context.Request = request
	after, err = taskTextEventCursor(context)
	if err != nil || after != 3 {
		t.Fatalf("Last-Event-ID cursor = %d, err = %v", after, err)
	}
}

func TestTaskTextEventCursorRejectsInvalidValues(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, query := range []string{"after=abc", "after=-1"} {
		t.Run(query, func(t *testing.T) {
			request := httptest.NewRequest("GET", "/api/tasks/task-1/text-events?"+query, nil)
			context, _ := gin.CreateTestContext(httptest.NewRecorder())
			context.Request = request
			if after, err := taskTextEventCursor(context); err == nil || after != 0 {
				t.Fatalf("cursor = %d, err = %v; want a rejected cursor", after, err)
			}
		})
	}
}

func TestStreamTaskTextEventsCachedReplayReachesTerminalWithoutDuplicateDelta(t *testing.T) {
	t.Setenv("REDIS_URL", "")
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.TaskTextDelta{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: "task", UserID: "user", Status: model.TaskStatusRunning}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.TaskTextDelta{ID: "delta", UserID: "user", TaskID: "task", Sequence: 8, Content: "text", ExpiresAt: time.Now().Add(time.Hour)}).Error; err != nil {
		t.Fatal(err)
	}
	svc := app.New(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = svc.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	replayAPI := appTextReplayAPI{svc}
	initial, err := replayAPI.CachedRead(ctx, "user", "task", 7)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", "task").Updates(map[string]any{"status": model.TaskStatusSucceeded, "progress": 100}).Error; err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Request = httptest.NewRequest("GET", "/api/tasks/task/text-events", nil).WithContext(ctx)
	streamTaskTextEvents(c, replayAPI, "user", "task", 7, initial)
	body := response.Body.String()
	if strings.Count(body, "id: 8\nevent: delta") != 1 || !strings.Contains(body, "event: terminal") || !strings.Contains(body, `"progress":100`) {
		t.Fatalf("unexpected cached SSE stream: %q", body)
	}
}

func TestStreamTaskTextEventsWritesSequenceAndTerminalEvent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = httptest.NewRequest("GET", "/api/tasks/task-1/text-events", nil)
	replay := &textreplay.Result{
		Deltas:    []model.TaskTextDelta{{Sequence: 8, Content: "增量"}},
		Complete:  true,
		FinalText: "增量",
		Status:    model.TaskStatusSucceeded,
		Stage:     "已完成",
		Progress:  100,
	}
	streamTaskTextEvents(context, nil, "user-1", "task-1", 7, replay)
	if response.Header().Get("Content-Type") != "text/event-stream; charset=utf-8" {
		t.Fatalf("content type = %q", response.Header().Get("Content-Type"))
	}
	body := response.Body.String()
	if !strings.Contains(body, "event: progress") || !strings.Contains(body, `"progress":100`) || !strings.Contains(body, "id: 8\nevent: delta") || !strings.Contains(body, "event: terminal") {
		t.Fatalf("unexpected SSE body: %q", body)
	}
}

func textReplayRouter(t *testing.T) (*gin.Engine, *app.Service, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "workspace.db")+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := app.New(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = svc.Close() })
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: "replay-1", UserID: owner.ID, Type: "canvas_text", Status: model.TaskStatusTextReplay, Stage: "文本持久化（前端自管）"}).Error; err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: owner.ID, DataDir: t.TempDir()}))
	api := router.Group("/api")
	RegisterTaskRoutes(api, svc)
	return router, svc, owner.ID
}

func TestTextReplayHTTPOwnerCursorAndClose(t *testing.T) {
	router, _, ownerID := textReplayRouter(t)
	postDelta := func(content string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"content": content})
		req := httptest.NewRequest(http.MethodPost, "/api/tasks/replay-1/text-deltas", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	if rec := postDelta("one"); rec.Code != http.StatusOK {
		t.Fatalf("append one: %d %s", rec.Code, rec.Body.String())
	}
	if rec := postDelta("two"); rec.Code != http.StatusOK {
		t.Fatalf("append two: %d %s", rec.Code, rec.Body.String())
	}
	req := httptest.NewRequest(http.MethodGet, "/api/tasks/replay-1/text-deltas?after=1", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("cursor read: %d %s", rec.Code, rec.Body.String())
	}
	var envelope struct {
		Data textreplay.Result `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if len(envelope.Data.Deltas) != 1 || envelope.Data.Deltas[0].Content != "two" || envelope.Data.Complete {
		t.Fatalf("cursor payload: %#v", envelope.Data)
	}

	completeBody, _ := json.Marshal(map[string]string{"text": "onetwo"})
	completeReq := httptest.NewRequest(http.MethodPost, "/api/tasks/replay-1/text-replay-complete", bytes.NewReader(completeBody))
	completeReq.Header.Set("Content-Type", "application/json")
	completeRec := httptest.NewRecorder()
	router.ServeHTTP(completeRec, completeReq)
	if completeRec.Code != http.StatusOK {
		t.Fatalf("complete: %d %s", completeRec.Code, completeRec.Body.String())
	}
	closed := postDelta("late")
	if closed.Code == http.StatusOK {
		t.Fatalf("closed append succeeded: %s", closed.Body.String())
	}

	eventsReq := httptest.NewRequest(http.MethodGet, "/api/tasks/replay-1/text-events?after=0", nil)
	eventsRec := httptest.NewRecorder()
	router.ServeHTTP(eventsRec, eventsReq)
	body := eventsRec.Body.String()
	if !strings.Contains(body, "event: terminal") || !strings.Contains(body, `"finalText":"onetwo"`) {
		t.Fatalf("terminal SSE: %q owner=%s", body, ownerID)
	}
}
