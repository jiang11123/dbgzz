package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/conversation"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/workspace"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func conversationRouter(t *testing.T) (*gin.Engine, *app.Service) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "workspace.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := app.New(repository.New(db), t.TempDir())
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: owner.ID, DataDir: t.TempDir()}))
	api := router.Group("/api")
	conversations := conversation.New(conversation.NewStore(repository.New(db)))
	RegisterCreationConversationRoutes(api, svc, conversations)
	return router, svc
}

func TestCreationConversationRoutesRegisterOnDesktopAPI(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterDesktopCanvasAPI(router.Group("/api"), &app.Service{})
	wanted := map[string]bool{
		"GET /api/creation-conversations":         false,
		"POST /api/creation-conversations/import": false,
		"PUT /api/creation-conversations/:id":     false,
		"DELETE /api/creation-conversations/:id":  false,
	}
	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		if _, exists := wanted[key]; exists {
			wanted[key] = true
		}
	}
	for route, found := range wanted {
		if !found {
			t.Errorf("desktop route %s is not registered", route)
		}
	}
}

func TestCreationConversationPutGetAndConflict(t *testing.T) {
	router, _ := conversationRouter(t)
	body := []byte(`{"expectedRevision":0,"document":{"id":"conversation-1","title":"第一镜","messages":[{"id":"m1","role":"user","content":"hi"}]}}`)
	put := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/creation-conversations/conversation-1", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(put, req)
	if put.Code != http.StatusOK {
		t.Fatalf("put status=%d body=%s", put.Code, put.Body.String())
	}
	replay := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/creation-conversations/conversation-1", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(replay, req)
	if replay.Code != http.StatusOK {
		t.Fatalf("lost-ack replay status=%d body=%s", replay.Code, replay.Body.String())
	}
	changed := []byte(`{"expectedRevision":0,"document":{"id":"conversation-1","title":"第二镜","messages":[{"id":"m1","role":"user","content":"hi"}]}}`)
	conflict := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/creation-conversations/conversation-1", bytes.NewReader(changed))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(conflict, req)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflict status=%d body=%s", conflict.Code, conflict.Body.String())
	}
	get := httptest.NewRecorder()
	router.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/creation-conversations/conversation-1", nil))
	if get.Code != http.StatusOK {
		t.Fatalf("get status=%d body=%s", get.Code, get.Body.String())
	}
	var envelope struct {
		Code int
		Data struct {
			Revision int64
			Document json.RawMessage
		}
	}
	if err := json.Unmarshal(get.Body.Bytes(), &envelope); err != nil || envelope.Code != 0 || envelope.Data.Revision != 1 {
		t.Fatalf("get envelope=%s err=%v", get.Body.String(), err)
	}
}

func TestCreationConversationImportSkipsTombstone(t *testing.T) {
	router, _ := conversationRouter(t)
	putBody := []byte(`{"expectedRevision":0,"document":{"id":"conversation-dead","title":"旧","messages":[]}}`)
	put := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/creation-conversations/conversation-dead", bytes.NewReader(putBody))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(put, req)
	if put.Code != http.StatusOK {
		t.Fatalf("put status=%d body=%s", put.Code, put.Body.String())
	}
	del := httptest.NewRecorder()
	router.ServeHTTP(del, httptest.NewRequest(http.MethodDelete, "/api/creation-conversations/conversation-dead?expectedRevision=1", nil))
	if del.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", del.Code, del.Body.String())
	}
	importBody := []byte(`{"operationId":"creation-conversations-v1:conversation-dead","document":{"id":"conversation-dead","title":"复活","messages":[]}}`)
	imp := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/creation-conversations/import", bytes.NewReader(importBody))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(imp, req)
	if imp.Code != http.StatusOK {
		t.Fatalf("import status=%d body=%s", imp.Code, imp.Body.String())
	}
	var envelope struct {
		Data struct {
			Imported bool
			Deleted  bool
		}
	}
	if err := json.Unmarshal(imp.Body.Bytes(), &envelope); err != nil || envelope.Data.Imported || !envelope.Data.Deleted {
		t.Fatalf("import envelope=%s err=%v", imp.Body.String(), err)
	}
}

func TestCreationConversationRoutesFailClosedWithoutService(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterCreationConversationRoutes(router.Group("/api"), &app.Service{}, nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/creation-conversations", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil conversation service status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
