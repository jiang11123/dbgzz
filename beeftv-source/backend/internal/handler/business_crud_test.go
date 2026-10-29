package handler

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

// Exercise the mounted handlers advertised to external clients, with isolated
// workspace data. Authentication itself is covered by the gateway tests.
func TestBusinessProjectAndAssetCRUD(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	api := env.router.Group("/api")
	api.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{RequestCoordinator: &stubRequestCoordinator{allowed: true}}))
	RegisterProjectRoutes(api, env.service)
	RegisterDesktopUserDataRoutes(api, env.service)
	catalog := NewBusinessCatalog(env.router.Routes())
	call := func(method, path string, body any) map[string]any {
		t.Helper()
		if _, ok := catalog.Match(method, path); !ok {
			t.Fatalf("not discoverable: %s %s", method, path)
		}
		data, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		req = WithExternalBusinessPrincipal(req, false)
		w := httptest.NewRecorder()
		env.router.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		var result struct {
			Code int            `json:"code"`
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Code != 0 {
			t.Fatalf("response: %s", w.Body.String())
		}
		return result.Data
	}
	project := call("POST", "/api/projects", map[string]any{"name": "MCP test", "type": "short-drama", "aspectRatio": "9:16", "sourceType": "blank"})["project"].(map[string]any)
	id := project["id"].(string)
	call("GET", "/api/projects", nil)
	call("GET", "/api/projects/"+id, nil)
	updated := call("PATCH", "/api/projects/"+id, map[string]any{"name": "renamed"})["project"].(map[string]any)
	if updated["name"] != "renamed" {
		t.Fatal("project rename lost")
	}
	call("DELETE", "/api/projects/"+id, nil)
	asset := map[string]any{"id": "business-text", "kind": "text", "title": "original", "coverUrl": "", "tags": []string{}, "data": map[string]any{"content": "preserve this"}}
	call("PUT", "/api/assets/business-text", map[string]any{"asset": asset})
	call("GET", "/api/assets", nil)
	call("GET", "/api/assets/business-text", nil)
	asset["title"] = "renamed"
	call("PUT", "/api/assets/business-text", map[string]any{"asset": asset})
	got := call("GET", "/api/assets/business-text", nil)["asset"].(map[string]any)
	if got["title"] != "renamed" {
		t.Fatal("asset rename lost")
	}
	call("DELETE", "/api/assets/business-text", nil)
}
