package bootstrap

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The real pi host fetches /ops before it listens for health. Status polling
// must not conceal a failed first launch by starting a replacement child.
func TestAssistantFirstLaunchCanReadRuntimeOperations(t *testing.T) {
	node := os.Getenv("BEEFTV_TEST_NODE")
	if node == "" {
		t.Skip("BEEFTV_TEST_NODE is required for the real host startup regression")
	}
	entry, err := filepath.Abs("../../../agent-host/server.mjs")
	if err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	write := func(name string, value any) {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dataDir, name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("agent_config.json", map[string]any{"model": "fixture-model", "hostCommand": node, "hostArgs": []string{entry}})
	write("local-model-config.json", map[string]any{
		"schemaVersion": 1, "revision": 1,
		"config": map[string]any{"textModel": "fixture::fixture-model", "channels": []any{
			map[string]any{"id": "fixture", "enabled": true, "apiKey": "fixture-key", "baseUrl": "https://example.invalid/v1",
				"modelProfiles": []any{map[string]any{"model": "fixture-model", "capability": "text", "protocol": "chat-completion"}}},
		}},
	})
	t.Setenv("BEEFTV_AGENT_MAX_REQUESTS", "0")
	r, err := Open(t.Context(), Config{Profile: ProfileDesktop, DataDir: dataDir, ListenAddr: "127.0.0.1:0", LaunchToken: "startup-fixture", AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := r.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	if err := r.Start(); err != nil {
		t.Fatal(err)
	}
	if r.assistantHost == nil || !r.assistantHost.Running() || r.assistantHost.PID() == 0 {
		t.Fatal("first launch did not survive startup; no status/Ensure request may repair this assertion")
	}
	if raw, err := os.ReadFile(filepath.Join(dataDir, "agent-requests.jsonl")); err == nil && len(raw) > 0 {
		t.Fatal("startup made a model request")
	}
	// The same dependency order must hold on exit: the official host releases
	// its running invocations before HTTP/ops disappears beneath it.
	hostRunningAtHTTPShutdown := make(chan bool, 1)
	r.httpServer.RegisterOnShutdown(func() { hostRunningAtHTTPShutdown <- r.assistantHost.Running() })
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := r.Close(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case running := <-hostRunningAtHTTPShutdown:
		if running {
			t.Fatal("HTTP closed before the official assistant host stopped")
		}
	case <-ctx.Done():
		t.Fatal("HTTP shutdown callback did not complete")
	}
}
