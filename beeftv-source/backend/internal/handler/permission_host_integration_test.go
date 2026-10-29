package handler

import (
	"context"
	"encoding/json"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/model"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestFullAccessActualDurableCrossCanvasMoveCrashReplayAndGroupUndo(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	const other = "permission-other"
	raw, err := env.service.UserCanvasProject(owner.ID, env.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var original map[string]any
	if json.Unmarshal(raw, &original) != nil {
		t.Fatal("original")
	}
	original["id"] = other
	original["revision"] = 0
	encoded, _ := json.Marshal(original)
	if _, err := env.service.UpsertUserCanvasProject(owner.ID, encoded); err != nil {
		t.Fatal(err)
	}
	const turn = "1234abcdeeff5678"
	env.beginTurn(t, turn, app.AssistantTurnInput{PermissionMode: "full-access"})
	backend := httptest.NewServer(env.router)
	defer backend.Close()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	config, _ := json.Marshal(map[string]any{"root": root, "directory": dir, "backend": backend.URL + "/api", "canvasId": env.canvasID, "otherCanvasId": other, "turnId": turn, "hostToken": assistantTestHostToken})
	file := filepath.Join(dir, "config.json")
	if err := os.WriteFile(file, config, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, "node", filepath.Join(root, "agent-host/test-support/permission-go-host-probe.mjs"), file).CombinedOutput(); err != nil {
		t.Fatalf("actual host: %v\n%s", err, output)
	}
	var receipts []model.AgentOpRecord
	if err := env.service.Database().Where("turn_id = ? AND status = ?", turn, "succeeded").Find(&receipts).Error; err != nil || len(receipts) != 2 {
		t.Fatalf("receipts=%d %v", len(receipts), err)
	}
	if _, err := env.service.UndoAssistantTurn(owner.ID, env.canvasID, turn); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{env.canvasID, other} {
		raw, err := env.service.UserCanvasProject(owner.ID, id)
		if err != nil {
			t.Fatal(err)
		}
		var restored map[string]any
		json.Unmarshal(raw, &restored)
		position := restored["nodes"].([]any)[0].(map[string]any)["position"].(map[string]any)
		if position["x"] != float64(0) || position["y"] != float64(0) {
			t.Fatalf("%s not restored: %v", id, position)
		}
	}
}
