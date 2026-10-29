package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestExternalAgentTokenCannotApproveCreationWithArbitraryOwner(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "creation-auth.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err = db.Create(&model.Workspace{ID: "local", Name: "本地工作区"}).Error; err != nil {
		t.Fatal(err)
	}
	service := app.NewLocal(repository.New(db), t.TempDir())
	trust := func(r *http.Request) bool {
		return r.Header.Get("X-Desktop-Token") == "launch" && r.Header.Get("X-Beeftv-UI-Bootstrap") == "ui"
	}
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{DesktopTrust: trust}))
	RegisterCreationRoutes(router.Group("/api"), service)

	created := creationAuthCall(t, router, http.MethodPost, "/api/creation-runs", map[string]string{
		"X-Desktop-Token": "launch", "X-Beeftv-UI-Bootstrap": "ui",
	}, `{"clientKey":"page-1","state":{}}`)
	if created.Code != http.StatusOK {
		t.Fatalf("trusted desktop UI should create a run: %d %s", created.Code, created.Body.String())
	}
	runID := creationAuthRunID(t, created.Body.Bytes())
	claimed := creationAuthCall(t, router, http.MethodPost, "/api/creation-runs/"+runID+"/claim", map[string]string{
		"X-Desktop-Token": "launch", "X-Beeftv-UI-Bootstrap": "ui",
	}, `{"expectedEpoch":0,"owner":"ui-123"}`)
	if claimed.Code != http.StatusOK {
		t.Fatalf("trusted desktop UI should claim with a window owner: %d %s", claimed.Code, claimed.Body.String())
	}

	clients := agentops.NewClientRegistry(t.TempDir())
	reg, token, err := clients.RegisterKind("codex", "codex", agentops.ClientReadWrite)
	if err != nil {
		t.Fatal(err)
	}
	agentHeaders := map[string]string{
		"X-Beeftv-Client": reg.ID, "Authorization": "Bearer " + token,
	}
	approveBody := `{"owner":"ui-123","executionEpoch":1,"submissionIds":["sub-1"]}`
	agentOnly := creationAuthCall(t, router, http.MethodPost, "/api/creation-runs/"+runID+"/submissions/approve", agentHeaders, approveBody)
	if agentOnly.Code != http.StatusForbidden {
		t.Fatalf("agent token must not approve creation: %d %s", agentOnly.Code, agentOnly.Body.String())
	}

	stolenDesktop := map[string]string{
		"X-Beeftv-Client": reg.ID, "Authorization": "Bearer " + token,
		"X-Desktop-Token": "launch", "X-Beeftv-UI-Bootstrap": "ui",
	}
	agentPlusDesktop := creationAuthCall(t, router, http.MethodPost, "/api/creation-runs/"+runID+"/submissions/approve", stolenDesktop, approveBody)
	if agentPlusDesktop.Code != http.StatusForbidden {
		t.Fatalf("agent token plus desktop headers must not approve creation: %d %s", agentPlusDesktop.Code, agentPlusDesktop.Body.String())
	}

	untrusted := creationAuthCall(t, router, http.MethodPost, "/api/creation-runs/"+runID+"/submissions/approve", map[string]string{
		"X-Desktop-Token": "launch",
	}, approveBody)
	if untrusted.Code != http.StatusForbidden {
		t.Fatalf("launch token without UI bootstrap must not approve: %d %s", untrusted.Code, untrusted.Body.String())
	}

	desktop := creationAuthCall(t, router, http.MethodPost, "/api/creation-runs/"+runID+"/submissions/approve", map[string]string{
		"X-Desktop-Token": "launch", "X-Beeftv-UI-Bootstrap": "ui",
	}, approveBody)
	if desktop.Code == http.StatusForbidden {
		t.Fatalf("trusted desktop UI was refused as an agent: %s", desktop.Body.String())
	}
}

func creationAuthCall(t *testing.T, router http.Handler, method, path string, headers map[string]string, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "http://127.0.0.1:18090"+path, strings.NewReader(body))
	request.Host = "127.0.0.1:18090"
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func creationAuthRunID(t *testing.T, raw []byte) string {
	t.Helper()
	var envelope struct {
		Data struct {
			Run struct {
				ID string `json:"id"`
			} `json:"run"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Run.ID == "" {
		t.Fatalf("missing run id: %s", raw)
	}
	return envelope.Data.Run.ID
}
