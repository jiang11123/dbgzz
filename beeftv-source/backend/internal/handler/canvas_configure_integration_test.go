package handler

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

func TestConfigureRealBusinessReceiptReplayCASAndUndo(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := env.service.UserCanvasProject(owner.ID, env.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var original map[string]any
	json.Unmarshal(raw, &original)
	node := original["nodes"].([]any)[0].(map[string]any)
	node["type"] = "video"
	node["metadata"] = map[string]any{"prompt": "submitted", "composerContent": "keep", "taskId": "old", "status": "success", "custom": "keep"}
	raw, _ = json.Marshal(original)
	created, err := env.service.UpsertUserCanvasProject(owner.ID, raw)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = env.service.UserCanvasProject(owner.ID, env.canvasID)
	json.Unmarshal(raw, &original)
	const turnID = "cc112233445566aa"
	env.beginTurn(t, turnID, assistantTurnInput(nil, nil))
	params, _ := json.Marshal(map[string]any{"canvasId": env.canvasID, "nodeId": "n1", "kind": "video", "expectedRevision": created.Revision, "patch": map[string]any{"size": "16:9", "seconds": "10", "generateAudio": "false", "vquality": "720p"}})
	for range 2 {
		status, body := env.opsRaw("canvas.node.configure", "configure-stable", turnID, string(params))
		if status != http.StatusOK {
			t.Fatalf("configure/replay %d %s", status, body)
		}
	}
	if status, _ := env.opsRaw("canvas.node.configure", "configure-stale", turnID, string(params)); status != http.StatusConflict {
		t.Fatalf("stale CAS %d", status)
	}
	if status, _ := env.opsRaw("canvas.node.configure", "configure-foreign", turnID, `{"canvasId":"foreign","nodeId":"n1","kind":"video","expectedRevision":1,"patch":{"seconds":"10"}}`); status != http.StatusForbidden {
		t.Fatalf("foreign canvas %d", status)
	}
	if revision, _ := env.canvasRevisionQuiet(); revision != created.Revision+1 {
		t.Fatalf("replay advanced revision %d", revision)
	}
	if err := env.service.FinalizeAssistantTurn(turnID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.UndoAssistantTurn(owner.ID, env.canvasID, turnID); err != nil {
		t.Fatal(err)
	}
	raw, _ = env.service.UserCanvasProject(owner.ID, env.canvasID)
	var restored map[string]any
	json.Unmarshal(raw, &restored)
	if !reflect.DeepEqual(original["nodes"], restored["nodes"]) {
		t.Fatalf("undo changed original generation/result fields: %s", raw)
	}
}
