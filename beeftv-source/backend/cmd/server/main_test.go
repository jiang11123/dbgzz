package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/bootstrap"

	"github.com/gin-gonic/gin"
)

func TestAllowedOriginWildcard(t *testing.T) {
	t.Setenv("CANVAS_CORS_ORIGINS", "*")
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest("GET", "http://backend/api/health", nil)
	if !allowedOrigin(context, "https://example.com") {
		t.Fatal("wildcard CORS should allow a valid HTTPS origin")
	}
	if allowedOrigin(context, "ftp://example.com") {
		t.Fatal("wildcard CORS should reject non-HTTP origins")
	}
}

func TestEnvironmentParsers(t *testing.T) {
	t.Setenv("CANVAS_AUTO_MIGRATE", "false")
	value, err := envBool("CANVAS_AUTO_MIGRATE", true)
	if err != nil || value {
		t.Fatalf("envBool = %v, %v", value, err)
	}
	t.Setenv("CANVAS_SHUTDOWN_TIMEOUT", "45s")
	duration, err := envDuration("CANVAS_SHUTDOWN_TIMEOUT", time.Minute)
	if err != nil || duration != 45*time.Second {
		t.Fatalf("envDuration = %v, %v", duration, err)
	}
}

func TestAllowedOriginUsesForwardedHost(t *testing.T) {
	t.Setenv("CANVAS_CORS_ORIGINS", "")
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest("GET", "http://backend/api/health", nil)
	context.Request.Header.Set("X-Forwarded-Host", " canvas.example.com, proxy.internal")
	if !allowedOrigin(context, "https://canvas.example.com") {
		t.Fatal("forwarded public host should be treated as same-origin")
	}
}

func TestParseCORSPolicyNormalizesConfiguredOrigins(t *testing.T) {
	policy, err := parseCORSPolicy(" https://Canvas.example.com/ , http://localhost:3000 ")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := policy.origins["https://canvas.example.com"]; !ok {
		t.Fatal("configured origin was not normalized")
	}
	if _, ok := policy.origins["http://localhost:3000"]; !ok {
		t.Fatal("configured port was not preserved")
	}
}

func TestParseCORSPolicyRejectsNonOriginValue(t *testing.T) {
	if _, err := parseCORSPolicy("https://example.com/app"); err == nil {
		t.Fatal("path-bearing CORS value should be rejected")
	}
	if _, err := parseCORSPolicy("ftp://example.com"); err == nil {
		t.Fatal("non-HTTP CORS value should be rejected")
	}
}

func TestAllowedOriginConfiguredListDoesNotFallbackToArbitraryLocalhost(t *testing.T) {
	t.Setenv("CANVAS_CORS_ORIGINS", "https://app.example.com")
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest("GET", "http://backend/api/health", nil)
	if allowedOrigin(context, "http://localhost:3000") {
		t.Fatal("configured CORS list should disable the implicit localhost fallback")
	}
}

func TestCORSPreflightTraceHeadersRespectConfiguredOrigins(t *testing.T) {
	t.Setenv("CANVAS_CORS_ORIGINS", "https://app.example.com")
	for _, tc := range []struct {
		name   string
		origin string
		status int
	}{
		{name: "configured origin", origin: "https://app.example.com", status: http.StatusNoContent},
		{name: "unconfigured remote origin", origin: "https://blocked.example.com", status: http.StatusForbidden},
		{name: "unconfigured localhost origin", origin: "http://localhost:3000", status: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			middleware, err := cors()
			if err != nil {
				t.Fatal(err)
			}
			called := false
			router := gin.New()
			router.Use(middleware)
			router.Any("/api/projects", func(c *gin.Context) {
				called = true
				c.Status(http.StatusOK)
			})
			request := httptest.NewRequest(http.MethodOptions, "http://backend/api/projects", nil)
			request.Header.Set("Origin", tc.origin)
			request.Header.Set("Access-Control-Request-Method", http.MethodPost)
			request.Header.Set("Access-Control-Request-Headers", "traceparent, x-canvas-trace-id")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != tc.status {
				t.Fatalf("preflight status = %d, want %d", response.Code, tc.status)
			}
			if called {
				t.Fatal("preflight executed the business handler")
			}
			if tc.status == http.StatusForbidden {
				if response.Header().Get("Access-Control-Allow-Origin") != "" {
					t.Fatal("forbidden origin received CORS authorization")
				}
				return
			}
			if got := response.Header().Get("Access-Control-Allow-Origin"); got != tc.origin {
				t.Fatalf("allowed origin = %q, want %q", got, tc.origin)
			}
			for _, requested := range []string{"traceparent", "x-canvas-trace-id"} {
				found := false
				for _, allowed := range strings.Split(response.Header().Get("Access-Control-Allow-Headers"), ",") {
					if strings.EqualFold(strings.TrimSpace(allowed), requested) {
						found = true
						break
					}
				}
				if !found {
					t.Fatalf("preflight does not allow requested header %q", requested)
				}
			}
		})
	}
}

func TestServerListenAddrDefaultsToLoopback(t *testing.T) {
	t.Setenv("CANVAS_BACKEND_ADDR", "")
	if got := env("CANVAS_BACKEND_ADDR", bootstrap.DefaultServerListenAddr); got != "127.0.0.1:8080" {
		t.Fatalf("empty CANVAS_BACKEND_ADDR = %q", got)
	}
	t.Setenv("CANVAS_BACKEND_ADDR", ":8080")
	if got := env("CANVAS_BACKEND_ADDR", bootstrap.DefaultServerListenAddr); got != ":8080" {
		t.Fatalf("explicit CANVAS_BACKEND_ADDR = %q", got)
	}
	if listenAddrBeyondLoopback("127.0.0.1:8080") || listenAddrBeyondLoopback("[::1]:8080") {
		t.Fatal("loopback listen should not be reported as exposed")
	}
	for _, addr := range []string{":8080", "0.0.0.0:8080", "192.168.1.8:8080", "localhost:8080"} {
		if !listenAddrBeyondLoopback(addr) {
			t.Fatalf("%s should be reported as beyond loopback", addr)
		}
	}
}
