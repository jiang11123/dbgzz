package main

import (
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	stdruntime "runtime"
	"strconv"
	"testing"
	"time"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/bootstrap"
)

// Exercise the built CLI and official MCP client against the actual integrated
// service, with a fresh SQLite workspace and no configured model provider.
func TestCLIAndMCPAgainstIsolatedIntegratedRuntime(t *testing.T) {
	if testing.Short() {
		t.Skip("builds CLI and starts isolated loopback service")
	}
	for _, key := range []string{"BEEFTV_CLIENT_ID", "BEEFTV_CLIENT_TOKEN", "BEEFTV_DESKTOP_TOKEN", "BEEFTV_AGENT_API_KEY", "BEEFTV_AGENT_HOST_TOKEN"} {
		t.Setenv(key, "")
	}
	bin := filepath.Join(t.TempDir(), "beeftv")
	if stdruntime.GOOS == "windows" {
		bin += ".exe"
	}
	build := exec.Command("go", "build", "-o", bin, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v %s", err, output)
	}
	t.Setenv("BEEFTV_BIN", bin)
	dataDir := t.TempDir()
	var runtime *bootstrap.Runtime
	start := func() {
		t.Helper()
		var err error
		runtime, err = bootstrap.Open(context.Background(), bootstrap.Config{Profile: bootstrap.ProfileServer, DataDir: dataDir, ListenAddr: "127.0.0.1:0", AutoMigrate: true, ShutdownTimeout: 5 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		if err := runtime.Start(); err != nil {
			t.Fatal(err)
		}
		t.Setenv("BEEFTV_BASE_URL", runtime.BaseURL())
		owner, err := agentops.EnsureOwnerToken(dataDir)
		if err != nil {
			t.Fatal(err)
		}
		t.Setenv("BEEFTV_OWNER_TOKEN", owner)
	}
	stop := func() {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if runtime != nil {
			if err := runtime.Close(ctx); err != nil {
				t.Error(err)
			}
		}
	}
	t.Cleanup(stop)
	start()
	cli := func(args ...string) map[string]any {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		output, err := exec.CommandContext(ctx, bin, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("CLI %v: %v %s", args, err, output)
		}
		var result map[string]any
		if err := json.Unmarshal(output, &result); err != nil {
			t.Fatalf("CLI output: %s %v", output, err)
		}
		return result
	}
	const canvasID = "integrated-cli-canvas"
	if err := seedCanvas(runtime.BaseURL(), canvasID); err != nil {
		t.Fatal(err)
	}
	read := cli("canvas", "get", "--canvas", canvasID, "--json")
	canvas := read["result"].(map[string]any)["canvas"].(map[string]any)
	revision := strconv.FormatInt(int64(canvas["revision"].(float64)), 10)
	createArgs := []string{"canvas", "nodes", "create", "--canvas", canvasID, "--expected-revision", revision, "--op-id", "integrated-create-once", "--node", "Persisted:image", "--json"}
	created := cli(createArgs...)
	if created["replayed"] != false {
		t.Fatalf("first call replayed: %+v", created)
	}
	stop()
	start()
	replayed := cli(createArgs...)
	if replayed["replayed"] != true {
		t.Fatalf("restart lost receipt: %+v", replayed)
	}
	read = cli("canvas", "get", "--canvas", canvasID, "--json")
	canvas = read["result"].(map[string]any)["canvas"].(map[string]any)
	if nodes := canvas["nodes"].([]any); len(nodes) != 1 {
		t.Fatalf("duplicate nodes after restart: %d", len(nodes))
	}
	t.Run("official-MCP-client", TestMCPClientLoop)
}
