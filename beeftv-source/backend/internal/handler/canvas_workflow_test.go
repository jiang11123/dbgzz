package handler

import (
	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/app"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCanvasWorkflowWritesRequireTrustedUI(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := &app.Service{}
	deps := defaultRuntimeDependencies(svc)
	deps.DesktopTrust = func(*http.Request) bool { return false }
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(deps))
	registerCanvasWorkflowRoutes(router.Group("/api"), svc)
	for _, route := range []struct{ method, path string }{{"POST", "/api/canvas-workflows"}, {"DELETE", "/api/canvas-workflows/template"}, {"POST", "/api/canvas-workflows/template/runs"}, {"POST", "/api/canvas-workflow-runs/run/retry"}, {"POST", "/api/canvas-workflow-runs/run/cancel"}} {
		request := httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("%s %s status=%d body=%s", route.method, route.path, response.Code, response.Body.String())
		}
	}
	want := map[string]bool{"GET /api/canvas-workflows": false, "GET /api/canvas-workflows/:id": false, "GET /api/canvas-workflows/:id/runs": false, "GET /api/canvas-workflow-runs/:id": false}
	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		if _, ok := want[key]; ok {
			want[key] = true
		}
	}
	for key, found := range want {
		if !found {
			t.Fatal("missing route " + key)
		}
	}
}
