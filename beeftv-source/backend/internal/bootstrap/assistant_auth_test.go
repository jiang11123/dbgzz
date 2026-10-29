package bootstrap

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/agentops"
)

func TestDesktopAssistantCredentialsAreSeparated(t *testing.T) {
	dir := t.TempDir()
	rt, err := Open(context.Background(), Config{Profile: ProfileDesktop, DataDir: dir, ListenAddr: "127.0.0.1:0", AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close(context.Background())
	client, credential, err := agentops.NewClientRegistry(dir).Register("test-read-only", agentops.ClientReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, origin, launch, ui string, external bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:54321/api"+path, strings.NewReader(`{"params":{"canvasId":"test","nodeId":"test","expectedRevision":0,"patch":{"title":"forbidden"}},"opId":"test"}`))
		r.RemoteAddr = "127.0.0.1:12345"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		r.Header.Set("X-Desktop-Token", launch)
		r.Header.Set("X-Beeftv-UI-Bootstrap", ui)
		if external {
			r.Header.Set("X-Beeftv-Client", client.ID)
			r.Header.Set("Authorization", "Bearer "+credential)
		}
		w := httptest.NewRecorder()
		rt.Handler().ServeHTTP(w, r)
		return w
	}
	for _, origin := range []string{"", "wails://wails", "http://wails.localhost", "https://wails.localhost"} {
		w := request("POST", "/assistant/ui-session", origin, rt.LaunchToken(), "", false)
		if w.Code != http.StatusForbidden {
			t.Fatalf("launch token alone elevated origin %q: %d", origin, w.Code)
		}
	}
	for _, origin := range []string{"wails://wails", "http://wails.localhost", "https://wails.localhost"} {
		w := request("POST", "/assistant/ui-session", origin, rt.LaunchToken(), rt.UIBootstrapToken(), false)
		if w.Code != http.StatusOK {
			t.Fatalf("native UI bootstrap %q failed: %d %s", origin, w.Code, w.Body.String())
		}
	}
	if w := request("POST", "/assistant/ui-session", "wails://attacker", rt.LaunchToken(), rt.UIBootstrapToken(), false); w.Code != 403 {
		t.Fatal("unknown origin accepted")
	}
	if w := request("GET", "/ops", "", "", "", true); w.Code != 200 {
		t.Fatalf("registered client needs no shell secret: %d %s", w.Code, w.Body.String())
	}
	for _, item := range []struct{ method, path string }{{"POST", "/ops/canvas.node.update"}, {"POST", "/ops/clients"}, {"POST", "/assistant/ui-session"}, {"POST", "/assistant/chat"}, {"PUT", "/canvas-projects/test"}} {
		if w := request(item.method, item.path, "", "", "", true); w.Code != 403 {
			t.Fatalf("external client escaped capability at %s: %d", item.path, w.Code)
		}
	}
	if w := request("POST", "/assistant/ui-session", "wails://wails", rt.LaunchToken(), rt.UIBootstrapToken(), true); w.Code != 403 {
		t.Fatal("client header exchanged for UI identity")
	}
	w := request("OPTIONS", "/assistant/chat", "wails://wails", "", "", false)
	if !strings.Contains(w.Header().Get("Access-Control-Allow-Headers"), "X-Beeftv-Ui-Session") {
		t.Fatal("native stream preflight omits UI session header")
	}
}
