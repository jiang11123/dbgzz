package handler

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/agentops"
)

func requestWithLocalAddr(addr net.Addr) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/agent-clients", nil)
	if addr == nil {
		return req
	}
	return req.WithContext(context.WithValue(req.Context(), http.LocalAddrContextKey, addr))
}

func TestExplicitBaseURLOnlyForLoopbackWithoutRuntimeDescriptor(t *testing.T) {
	dataDir := t.TempDir()
	loopback := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 8790}
	if got := explicitBaseURL(requestWithLocalAddr(loopback), dataDir); got != "http://127.0.0.1:8790/api" {
		t.Fatalf("loopback backend address: got %q", got)
	}
	v6 := &net.TCPAddr{IP: net.ParseIP("::1"), Port: 8790}
	if got := explicitBaseURL(requestWithLocalAddr(v6), dataDir); got != "http://[::1]:8790/api" {
		t.Fatalf("ipv6 loopback: got %q", got)
	}
	lan := &net.TCPAddr{IP: net.ParseIP("192.168.1.20"), Port: 8790}
	if got := explicitBaseURL(requestWithLocalAddr(lan), dataDir); got != "" {
		t.Fatalf("non-loopback address must never be written into client config: %q", got)
	}
	if got := explicitBaseURL(requestWithLocalAddr(nil), dataDir); got != "" {
		t.Fatalf("missing local address: got %q", got)
	}
}

func TestClientSetupCarriesBaseURLOnlyWhenGiven(t *testing.T) {
	reg := agentops.ClientRegistration{ID: "client-1", Mode: agentops.ClientReadOnly}
	cli := `C:\app\resources\cli\beeftv.exe`
	with := clientSetup(agentops.ClientKindCursor, cli, `C:\data`, "http://127.0.0.1:8790/api", reg, "tok")
	if !strings.Contains(with["json"].(string), `"BEEFTV_BASE_URL": "http://127.0.0.1:8790/api"`) {
		t.Fatalf("json setup lacks BEEFTV_BASE_URL: %v", with["json"])
	}
	without := clientSetup(agentops.ClientKindCursor, cli, `C:\data`, "", reg, "tok")
	if strings.Contains(without["json"].(string), "BEEFTV_BASE_URL") {
		t.Fatalf("desktop-style setup must stay unchanged: %v", without["json"])
	}
	codex := clientSetup(agentops.ClientKindCodex, cli, `C:\data`, "http://127.0.0.1:8790/api", reg, "tok")
	if !strings.Contains(codex["command"].(string), "--env BEEFTV_BASE_URL='http://127.0.0.1:8790/api'") {
		t.Fatalf("codex command lacks BEEFTV_BASE_URL: %v", codex["command"])
	}
	claude := clientSetup(agentops.ClientKindClaude, cli, `C:\data`, "http://127.0.0.1:8790/api", reg, "tok")
	if !strings.Contains(claude["command"].(string), "-e BEEFTV_BASE_URL='http://127.0.0.1:8790/api'") {
		t.Fatalf("claude command lacks BEEFTV_BASE_URL: %v", claude["command"])
	}
}
