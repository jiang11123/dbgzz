package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
)

func TestBeefAPIConnectionRoutesRequireWorkspaceAndHideSecrets(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	store, err := workspace.NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := beefapi.New(beefapi.Options{
		DataDir: dir, Origin: "http://127.0.0.1:9", Provider: store, ClientVersion: "test", Hostname: "test",
		HTTPClient: http.DefaultClient, OpenURL: func(string) error { return nil }, Sleep: func(time.Duration) {},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(connection.Close)
	service := app.NewLocal(nil, dir)
	service.SetBeefAPI(connection)
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dir}))
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{
		RequestCoordinator: &stubRequestCoordinator{allowed: true},
		ProviderConfig:     store,
		BeefAPI:            connection,
	}))
	RegisterWorkspaceRoutes(router.Group("/api"), service)
	RegisterBeefAPIConnectionRoutes(router.Group("/api"), service)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/beefapi/connection", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var envelope struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data["state"] != beefapi.StateDisconnected {
		t.Fatalf("state = %#v", envelope.Data["state"])
	}
	if _, exists := envelope.Data["apiKey"]; exists {
		t.Fatalf("connection summary leaked apiKey: %#v", envelope.Data)
	}
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/beefapi/connection/models", strings.NewReader(`{"apiKey":"client-forged","models":[{"id":"seedance-2.0-portrait"}]}`)))
	if recorder.Code == http.StatusOK || strings.Contains(recorder.Body.String(), "client-forged") {
		t.Fatal("disconnected catalog endpoint accepted or exposed client credentials")
	}
}
