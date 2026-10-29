package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

type stubRequestCoordinator struct {
	allowed bool
	retry   time.Duration
	calls   int
}

func (s *stubRequestCoordinator) AllowRequest(context.Context, string, int, time.Duration) (bool, error) {
	s.calls++
	return s.allowed, nil
}

func (s *stubRequestCoordinator) RequestRetryAfter(context.Context, string, time.Duration) time.Duration {
	return s.retry
}

func TestRuntimeDependenciesKeepRoutersIsolated(t *testing.T) {
	gin.SetMode(gin.TestMode)
	allowed := &stubRequestCoordinator{allowed: true}
	blocked := &stubRequestCoordinator{allowed: false, retry: 3 * time.Second}

	newRouter := func(coordinator RequestCoordinator) *gin.Engine {
		router := gin.New()
		router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{RequestCoordinator: coordinator}))
		router.GET("/limited", func(c *gin.Context) {
			if !enforceRateLimit(c, "test", 1, time.Minute) {
				return
			}
			c.Status(http.StatusNoContent)
		})
		return router
	}

	first := httptest.NewRecorder()
	newRouter(allowed).ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/limited", nil))
	if first.Code != http.StatusNoContent {
		t.Fatalf("allowed router status = %d, want %d", first.Code, http.StatusNoContent)
	}

	second := httptest.NewRecorder()
	newRouter(blocked).ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/limited", nil))
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("blocked router status = %d, want %d", second.Code, http.StatusTooManyRequests)
	}
	if got := second.Header().Get("Retry-After"); got != "3" {
		t.Fatalf("Retry-After = %q, want 3", got)
	}
	if allowed.calls != 1 || blocked.calls != 1 {
		t.Fatalf("coordinator calls = (%d, %d), want (1, 1)", allowed.calls, blocked.calls)
	}
}
