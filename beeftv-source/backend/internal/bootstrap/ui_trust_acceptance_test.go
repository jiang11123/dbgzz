package bootstrap

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"infinite-canvas/backend/internal/agentops"
)

func TestOpsAcceptanceClientCannotBecomeUIOrManageClients(t *testing.T) {
	t.Setenv("BEEFTV_UI_BOOTSTRAP", "")
	h := newDesktopHarness(t)
	registry := agentops.NewClientRegistry(h.dataDir)
	for _, mode := range []agentops.ClientMode{agentops.ClientReadOnly, agentops.ClientReadWrite} {
		t.Run(string(mode), func(t *testing.T) {
			client, token, err := registry.Register("acceptance", mode)
			if err != nil {
				t.Fatal(err)
			}
			issued := h.desktopUI("POST", "/assistant/ui-session", "")
			if issued.Code != http.StatusOK {
				t.Fatalf("UI control failed: %d %s", issued.Code, issued.Body.String())
			}
			data, _ := decodeEnvelope(t, issued)
			uiToken, ok := data["token"].(string)
			if !ok || uiToken == "" {
				t.Fatal("UI control issued no token")
			}
			before := len(registry.List())
			for _, route := range []struct{ method, path string }{
				{"GET", "/agent-clients"}, {"POST", "/agent-clients"}, {"DELETE", "/agent-clients/" + client.ID},
				{"GET", "/ops/clients"}, {"POST", "/ops/clients"}, {"POST", "/assistant/ui-session"},
			} {
				t.Run(route.method+route.path, func(t *testing.T) {
					// Exercise handler-level rejection after passing the desktop transport gate.
					w := h.call(requestOptions{method: route.method, path: route.path, body: `{"kind":"codex","label":"forbidden","mode":"read-write"}`,
						clientID: client.ID, clientToken: token, launchToken: h.rt.LaunchToken(), uiBootstrap: h.rt.UIBootstrapToken(), origin: "wails://wails",
						extraHeaders: map[string]string{"X-Beeftv-Ui-Session": uiToken}})
					if w.Code != http.StatusForbidden {
						t.Fatalf("client elevated: %d %s", w.Code, w.Body.String())
					}
				})
			}
			if len(registry.List()) != before {
				t.Fatal("denied management changed registrations")
			}
			if _, ok := registry.Lookup(client.ID, token); !ok {
				t.Fatal("denied revoke invalidated client")
			}
		})
	}
}

func TestOpsAcceptanceUIBootstrapCredentialIsolation(t *testing.T) {
	t.Setenv("BEEFTV_UI_BOOTSTRAP", "")
	h := newDesktopHarness(t)
	foreign := newDesktopHarness(t)
	for _, tc := range []struct{ name, launch, bootstrap string }{
		{"missing-both", "", ""},
		{"missing-bootstrap", h.rt.LaunchToken(), ""},
		{"missing-launch", "", h.rt.UIBootstrapToken()},
		{"foreign-bootstrap", h.rt.LaunchToken(), foreign.rt.UIBootstrapToken()},
		{"foreign-launch", foreign.rt.LaunchToken(), h.rt.UIBootstrapToken()},
		{"foreign-pair", foreign.rt.LaunchToken(), foreign.rt.UIBootstrapToken()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, route := range []struct{ method, path string }{{"POST", "/assistant/ui-session"}, {"GET", "/agent-clients"}, {"POST", "/agent-clients"}} {
				w := h.call(requestOptions{method: route.method, path: route.path, body: `{"kind":"codex","mode":"read-write"}`, origin: "wails://wails", launchToken: tc.launch, uiBootstrap: tc.bootstrap})
				if w.Code != http.StatusForbidden {
					t.Fatalf("%s %s: %d %s", route.method, route.path, w.Code, w.Body.String())
				}
			}
		})
	}
	if len(agentops.NewClientRegistry(h.dataDir).List()) != 0 {
		t.Fatal("invalid UI credentials created a client")
	}
	if w := h.desktopUI("POST", "/assistant/ui-session", ""); w.Code != http.StatusOK {
		t.Fatalf("valid UI rejected: %d %s", w.Code, w.Body.String())
	}
}

func TestOpsAcceptanceOriginAndLoopbackAtRouter(t *testing.T) {
	t.Setenv("BEEFTV_ALLOWED_ORIGINS", "https://app.beeftv.local")
	t.Setenv("BEEFTV_UI_BOOTSTRAP", "")
	h := newDesktopHarness(t)
	client, token, err := agentops.NewClientRegistry(h.dataDir).Register("acceptance", agentops.ClientReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, host, remote, origin string
		want                       int
	}{
		{"same-origin", "127.0.0.1:54321", "127.0.0.1:12345", "http://127.0.0.1:54321", 200},
		{"no-origin", "127.0.0.1:54321", "127.0.0.1:12345", "", 200},
		{"ipv6-loopback", "[::1]:54321", "[::1]:12345", "http://[::1]:54321", 200},
		{"allowed-origin", "127.0.0.1:54321", "127.0.0.1:12345", "https://app.beeftv.local", 200},
		{"different-port", "127.0.0.1:54321", "127.0.0.1:12345", "http://127.0.0.1:54322", 403},
		{"localhost-suffix", "127.0.0.1:54321", "127.0.0.1:12345", "http://localhost.attacker.example", 403},
		{"allowlist-suffix", "127.0.0.1:54321", "127.0.0.1:12345", "https://app.beeftv.local.attacker.example", 403},
		{"opaque-origin", "127.0.0.1:54321", "127.0.0.1:12345", "null", 403},
		{"foreign-host", "attacker.example", "127.0.0.1:12345", "https://app.beeftv.local", 403},
		{"foreign-remote", "127.0.0.1:54321", "203.0.113.4:12345", "https://app.beeftv.local", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, ui := range []bool{false, true} {
				method, path := "GET", "/ops"
				if ui {
					method, path = "POST", "/assistant/ui-session"
				}
				r := httptest.NewRequest(method, "http://"+tc.host+"/api"+path, nil)
				r.RemoteAddr = tc.remote
				r.Header.Set("Origin", tc.origin)
				// Forwarded headers must not override the transport peer or target host.
				r.Header.Set("X-Forwarded-For", "127.0.0.1")
				r.Header.Set("X-Forwarded-Host", "127.0.0.1:54321")
				if ui {
					r.Header.Set("X-Desktop-Token", h.rt.LaunchToken())
					r.Header.Set("X-Beeftv-UI-Bootstrap", h.rt.UIBootstrapToken())
				} else {
					r.Header.Set("X-Beeftv-Client", client.ID)
					r.Header.Set("Authorization", "Bearer "+token)
				}
				w := httptest.NewRecorder()
				h.rt.Handler().ServeHTTP(w, r)
				if w.Code != tc.want {
					t.Fatalf("%s: got %d want %d: %s", path, w.Code, tc.want, w.Body.String())
				}
			}
		})
	}
}
