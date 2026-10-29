package bootstrap

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/environment"
)

func TestEnvironmentRouteRequiresDesktopTrustAndIgnoresExternalPaths(t *testing.T) {
	dir := t.TempDir()
	r, err := Open(context.Background(), Config{Profile: ProfileDesktop, DataDir: dir, AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close(context.Background())
	// No listener or real model call is needed to exercise the production router.
	for _, authorized := range []bool{false, true} {
		request := httptest.NewRequest(http.MethodPost, "/api/diagnostics/environment", strings.NewReader(`{"repair":true,"dataDir":"/untrusted-input"}`))
		request.Header.Set("Content-Type", "application/json")
		if authorized {
			request.Header.Set("X-Desktop-Token", r.LaunchToken())
		}
		response := httptest.NewRecorder()
		r.handler.ServeHTTP(response, request)
		if !authorized {
			if response.Code < 400 {
				t.Fatal("untrusted repair allowed", response.Code)
			}
			if _, err := os.Stat(filepath.Join(dir, "downloads")); !os.IsNotExist(err) {
				t.Fatal("untrusted repair mutated disk")
			}
			continue
		}
		if response.Code != http.StatusOK {
			t.Fatal(response.Code, response.Body.String())
		}
		var body struct {
			Data environment.Report `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if len(body.Data.Checks) < 7 || len(body.Data.Catalog.Cases) != 13 {
			t.Fatal("missing environment checks", response.Body.String())
		}
		if info, err := os.Stat(filepath.Join(dir, "downloads")); err != nil || !info.IsDir() {
			t.Fatal("repair missed owned data directory", err)
		}
		if strings.Contains(response.Body.String(), dir) {
			t.Fatal("response exposed machine path")
		}
	}
}
