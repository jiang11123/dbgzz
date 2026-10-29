package httptransport

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequireLaunchTokenProtectsDesktopAPI(t *testing.T) {
	protected := RequireLaunchToken("desktop-secret")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	tests := []struct {
		name   string
		token  string
		status int
	}{
		{name: "missing", status: http.StatusForbidden},
		{name: "incorrect", token: "wrong", status: http.StatusForbidden},
		{name: "correct", token: "desktop-secret", status: http.StatusNoContent},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
			if test.token != "" {
				request.Header.Set(LaunchTokenHeader, test.token)
			}
			response := httptest.NewRecorder()
			protected.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			if test.status == http.StatusForbidden && !strings.Contains(response.Body.String(), `"code":403`) {
				t.Fatalf("body = %q, want standard forbidden envelope", response.Body.String())
			}
		})
	}
}

func TestRequireLaunchTokenLeavesLivenessPublic(t *testing.T) {
	protected := RequireLaunchToken("desktop-secret")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	response := httptest.NewRecorder()
	protected.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/health/live", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want liveness passthrough", response.Code)
	}
}

func TestRequireLaunchTokenAllowsCORSPreflight(t *testing.T) {
	protected := RequireLaunchToken("desktop-secret")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	response := httptest.NewRecorder()
	protected.ServeHTTP(response, httptest.NewRequest(http.MethodOptions, "/api/tasks", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want preflight passthrough", response.Code)
	}
}

func TestNewLaunchTokenReturnsIndependent256BitTokens(t *testing.T) {
	first, err := NewLaunchToken()
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewLaunchToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 64 || len(second) != 64 || first == second {
		t.Fatalf("tokens must be distinct 32-byte hex values: %q %q", first, second)
	}
}
