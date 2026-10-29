package bootstrap

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestDesktopCORSAllowsModelRelayPreflight(t *testing.T) {
	router := gin.New()
	router.Use(desktopCORSMiddleware())
	forwarded := false
	router.POST("/api/ai/custom", func(c *gin.Context) {
		forwarded = true
		c.Status(http.StatusNoContent)
	})
	for _, origin := range []string{"wails://wails", "http://wails.localhost"} {
		t.Run(origin, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodOptions, "/api/ai/custom", nil)
			request.Header.Set("Origin", origin)
			requested := []string{"authorization", "content-type", "traceparent", "x-canvas-trace-id", "x-desktop-token", "x-canvas-upstream-url", "x-canvas-upstream-format", "x-canvas-upstream-base-url", "x-canvas-upstream-headers"}
			request.Header.Set("Access-Control-Request-Method", "POST")
			request.Header.Set("Access-Control-Request-Headers", strings.Join(requested, ","))
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusNoContent || forwarded {
				t.Fatalf("preflight must finish without invoking the relay: status=%d forwarded=%v", response.Code, forwarded)
			}
			if response.Header().Get("Access-Control-Allow-Origin") != origin || response.Header().Get("Access-Control-Allow-Credentials") != "true" {
				t.Fatal("desktop origin and credential policy were not retained")
			}
			allowed := map[string]bool{}
			for _, name := range strings.Split(response.Header().Get("Access-Control-Allow-Headers"), ",") {
				allowed[strings.ToLower(strings.TrimSpace(name))] = true
			}
			for _, name := range requested {
				if !allowed[name] {
					t.Errorf("browser will block model relay header %q", name)
				}
			}
		})
	}
}
