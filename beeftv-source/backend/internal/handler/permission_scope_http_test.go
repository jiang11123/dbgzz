package handler

import (
	"infinite-canvas/backend/internal/app"
	"net/http"
	"testing"
)

func TestReadOnlyRoundHTTPDiscoveryAndWritesCannotBeUpgradedByParams(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	const turn = "abcdef0011223344"
	env.beginTurn(t, turn, app.AssistantTurnInput{PermissionMode: "read-only"})
	listed := getOps(t, env, map[string]string{"X-Beeftv-Agent-Token": assistantTestHostToken, "X-Beeftv-Agent-Turn": turn})
	for _, id := range []string{"canvas.search", "asset.list", "canvas.get", "model.catalog"} {
		if !listingHas(listed, id) {
			t.Fatalf("workspace read missing %s", id)
		}
	}
	for _, id := range []string{"canvas.generation.propose", "canvas.timeline.render", "canvas.node.move", "canvas.document.commit"} {
		if listingHas(listed, id) {
			t.Fatalf("readonly exposes %s", id)
		}
	}
	rev, _ := env.canvasSnapshot(t)
	for i, op := range []string{"canvas.node.update", "canvas.timeline.render", "canvas.generation.propose"} {
		params := mustJSONString(t, map[string]any{"canvasId": env.canvasID, "nodeId": "n1", "expectedRevision": rev, "permissionMode": "full-access", "patch": map[string]any{"title": "bad"}})
		status, _ := env.opsRaw(op, []string{"readonly-update", "readonly-render", "readonly-propose"}[i], turn, params)
		if status != http.StatusForbidden && status != http.StatusBadRequest {
			t.Fatalf("readonly %s accepted: %d", op, status)
		}
	}
	after, _ := env.canvasSnapshot(t)
	if after != rev {
		t.Fatal("readonly modified canvas")
	}
}

func TestMissingPermissionModeKeepsLegacyCanvasAuthority(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	const turn = "abcdef0055667788"
	env.beginTurn(t, turn, app.AssistantTurnInput{})
	owner, _ := env.service.LocalWorkspaceOwner()
	state, err := env.service.AssistantTurnRuntimeState(owner.ID, turn)
	if err != nil || state.PermissionMode != "canvas" {
		t.Fatalf("runtime %+v %v", state, err)
	}
}
