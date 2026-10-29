package handler

import (
	"testing"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

func TestAppearanceRoutesAreRegistered(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterDesktopAppearanceRoutes(router.Group("/api"), &app.Service{})
	wanted := map[string]bool{
		"GET /api/public/appearance":              false,
		"GET /api/public/appearance/assets/:slot": false,
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
}
