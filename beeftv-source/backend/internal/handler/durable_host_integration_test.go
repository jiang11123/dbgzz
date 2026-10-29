package handler

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestDurableActualHostRestartsAgainstRealGoTurnAndUndo(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	const turnID = "112233aabbccdd44"
	env.beginTurn(t, turnID, assistantTurnInput(nil, nil))
	backend := httptest.NewServer(env.router)
	defer backend.Close()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	config, err := json.Marshal(map[string]any{"root": root, "directory": directory, "backend": backend.URL + "/api", "canvasId": env.canvasID, "turnId": turnID, "hostToken": assistantTestHostToken})
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(directory, "config.json")
	if err := os.WriteFile(configPath, config, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", filepath.Join(root, "agent-host/test-support/durable-go-host-probe.mjs"), configPath)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("real Durable host/Go probe failed: %v\n%s", err, output)
	}
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := env.service.UserCanvasProject(owner.ID, env.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Nodes       []any `json:"nodes"`
		Connections []any `json:"connections"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Nodes) != 3 || len(doc.Connections) != 2 {
		t.Fatalf("duplicate/missing effects: %s", raw)
	}
	if _, err := env.service.UndoAssistantTurn(owner.ID, env.canvasID, turnID); err != nil {
		t.Fatal(err)
	}
	raw, err = env.service.UserCanvasProject(owner.ID, env.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Nodes) != 1 || len(doc.Connections) != 0 {
		t.Fatalf("undo did not restore original: %s", raw)
	}
}
