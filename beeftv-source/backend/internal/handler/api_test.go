package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/repository"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestRegisterCanvasAPIExposesOpenAPIAndProjects(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterCanvasAPI(router.Group("/api"), &app.Service{})

	wanted := map[string]bool{
		"GET /api/openapi.yaml":          false,
		"GET /api/projects":              false,
		"POST /api/tasks":                false,
		"POST /api/timeline/render-plan": false,
		"GET /api/resources":             false,
	}
	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		if _, exists := wanted[key]; exists {
			wanted[key] = true
		}
	}
	for route, found := range wanted {
		if !found {
			t.Errorf("route %s is not registered", route)
		}
	}

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/openapi.yaml", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "openapi: 3.0.3") || !strings.Contains(recorder.Body.String(), "url: /api") {
		t.Fatalf("openapi.yaml status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestRegisterDesktopCanvasAPIExcludesHostedOnlyRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterDesktopCanvasAPI(router.Group("/api"), &app.Service{})

	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		if key == "POST /api/creation-runs/:id/submissions/refresh" {
			t.Fatalf("desktop API must not expose obsolete quote refresh route %s", key)
		}
		switch key {
		case "POST /api/login", "POST /api/register", "GET /api/auth/me",
			"GET /api/finance/account", "POST /api/payments/orders",
			"GET /api/admin/users", "GET /api/admin/analytics/overview",
			"GET /api/announcements", "POST /api/canvas-shares":
			t.Fatalf("desktop API must not expose hosted-only route %s", key)
		}
	}

	wanted := map[string]bool{
		"GET /api/workspace/bootstrap":                     false,
		"POST /api/resources":                              false,
		"POST /api/tasks":                                  false,
		"POST /api/ai/models":                              false,
		"GET /api/beefapi/connection":                      false,
		"POST /api/beefapi/connection/start":               false,
		"GET /api/creation-conversations":                  false,
		"PUT /api/creation-conversations/:id":              false,
		"GET /api/canvas-folders":                          false,
		"PUT /api/canvas-folders/:id":                      false,
		"PUT /api/canvas-projects/:id/drawings/:drawingId": false,
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
	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		if key == "GET /api/models" || key == "POST /api/models/available" || key == "POST /api/models/:id/quote" || key == "GET /api/model-catalog" || key == "POST /api/model-catalog/available" || strings.HasSuffix(route.Path, "/api/ai/system/:channelId/*path") {
			t.Fatalf("desktop API must not expose SaaS model catalog route %s", key)
		}
	}

	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		switch key {
		case "GET /api/settings/oss", "PATCH /api/settings/oss", "POST /api/settings/oss/test",
			"POST /api/resources/:id/ark-private-asset", "GET /api/resources/:id/oss-url",
			"POST /api/resources/import",
			"GET /api/admin/settings/appearance", "PATCH /api/admin/settings/appearance",
			"DELETE /api/admin/settings/appearance", "POST /api/admin/settings/appearance/assets/:slot",
			"GET /api/admin/settings/features", "PATCH /api/admin/settings/features",
			"GET /api/admin/settings/response-interception", "PATCH /api/admin/settings/response-interception",
			"GET /api/admin/text-replay-stats",
			"POST /api/canvas-projects/:id/import/libtv", "POST /api/canvas-projects/:id/import/tapnow",
			"POST /api/runninghub/workflow-info", "POST /api/runninghub/app-info",
			"GET /api/public/resources/:id/file", "GET /api/public/resources/:id/file/:filename":
			t.Fatalf("desktop API must not expose hosted storage route %s", key)
		}
		if key == "POST /api/skills/install/github" || key == "POST /api/skills/:id/sync" {
			t.Fatalf("desktop API must not expose remote skill route %s", key)
		}
		if strings.HasPrefix(key, "GET /api/admin/plugins") || strings.HasPrefix(key, "PUT /api/admin/plugins") {
			t.Fatalf("desktop API must not expose plugin admin route %s", key)
		}
	}

	// Keep the desktop surface local-first by default. New hosted routes must
	// opt in explicitly to the server profile instead of being added to the
	// shared registration path by accident.
	hostedPrefixes := []string{
		"/api/login", "/api/register", "/api/auth/", "/api/oauth/",
		"/api/finance", "/api/payments", "/api/admin", "/api/announcements",
		"/api/canvas-shares", "/api/model-catalog", "/api/models",
		"/api/ai/system/", "/api/settings/oss", "/api/runninghub/",
		"/api/resources/import", "/api/resources/", // filtered below for local resource routes
	}
	for _, route := range router.Routes() {
		for _, prefix := range hostedPrefixes {
			if prefix == "/api/resources/" {
				if !strings.HasPrefix(route.Path, prefix) {
					continue
				}
				if strings.HasSuffix(route.Path, "/oss-url") || strings.Contains(route.Path, "/ark-private-asset") || strings.Contains(route.Path, "/public/") {
					t.Fatalf("desktop API must not expose hosted resource route %s %s", route.Method, route.Path)
				}
				continue
			}
			if strings.HasPrefix(route.Path, prefix) {
				t.Fatalf("desktop API must not expose hosted route %s %s", route.Method, route.Path)
			}
		}
	}
}

func TestRegisterCanvasAPIOmitsLegacyNodeMutationRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for name, register := range map[string]func(*gin.RouterGroup, *app.Service){
		"canvas":  RegisterCanvasAPI,
		"desktop": RegisterDesktopCanvasAPI,
	} {
		t.Run(name, func(t *testing.T) {
			router := gin.New()
			register(router.Group("/api"), &app.Service{})
			for _, route := range router.Routes() {
				key := route.Method + " " + route.Path
				switch key {
				case "DELETE /api/canvas-projects/:id/nodes/:nodeId",
					"PATCH /api/canvas-projects/:id/nodes/:nodeId",
					"POST /api/canvas-projects/:id/connections",
					"PUT /api/canvas-projects/:id/generated-assets":
					t.Fatalf("%s still registers retired canvas route %s", name, key)
				}
			}
		})
	}
}

func TestRegisterCanvasAPIDerivesLocalProfileFromService(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := app.NewLocal(repository.New(db), t.TempDir())
	router := gin.New()
	RegisterCanvasAPI(router.Group("/api"), svc)

	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		switch key {
		case "POST /api/login", "POST /api/register", "GET /api/auth/me", "POST /api/payments/orders", "GET /api/announcements":
			t.Fatalf("local service profile must not expose hosted route %s", key)
		}
	}
}
