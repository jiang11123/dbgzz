package handler

import (
	"encoding/json"
	"net/http"
	"testing"

	"infinite-canvas/backend/internal/app"
)

func TestSkillContextHTTPRequiresHostAndExactBoundSession(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	path := "/assistant/runtime/canvases/" + env.canvasID + "/skill-context"
	headers := map[string]string{"X-Beeftv-Agent-Token": assistantTestHostToken}
	if response := env.call(t, http.MethodGet, path+"?sessionId="+skillSessionOne, ""); response.Code != http.StatusForbidden {
		t.Fatalf("UI bypassed host %d %s", response.Code, response.Body)
	}
	get := env.callWithHeaders(t, http.MethodGet, path+"?sessionId="+skillSessionOne, "", headers)
	initial := decodeEnvelope(t, get)
	if initial["revision"] != float64(0) || initial["lifecycle"] != "active" {
		t.Fatalf("initial context %+v", initial)
	}
	pin := installTestSkill(t, env, owner.ID, map[string]string{"SKILL.md": "---\nname: Context\ndescription: method\n---\nFollow this rule"})
	change, _ := json.Marshal(map[string]any{"sessionId": skillSessionOne, "action": "activate", "requestId": "select", "expectedRevision": 0, "pins": []any{pin}})
	response := env.callWithHeaders(t, http.MethodPost, path, string(change), headers)
	active := decodeEnvelope(t, response)
	if active["revision"] != float64(1) || len(active["activePins"].([]any)) != 1 {
		t.Fatalf("activation %+v", active)
	}
	response = env.callWithHeaders(t, http.MethodPost, path, `{"sessionId":"`+skillSessionOne+`","action":"clear","requestId":"stale","expectedRevision":0}`, headers)
	if response.Code != http.StatusConflict || envelopeReason(t, response.Body.String()) != "skill_context_revision_conflict" {
		t.Fatalf("CAS did not reject %d %s", response.Code, response.Body)
	}
	response = env.callWithHeaders(t, http.MethodPost, path, `{"sessionId":"`+skillSessionOne+`","action":"clear","requestId":"spoof","expectedRevision":1,"userId":"someone"}`, headers)
	if response.Code != http.StatusBadRequest {
		t.Fatal("accepted spoofed owner")
	}
	turnID := "abcdabcd11112222"
	env.beginTurn(t, turnID, app.AssistantTurnInput{})
	if err := env.service.BindAssistantDurableSession(owner.ID, turnID, skillSessionOne, false); err != nil {
		t.Fatal(err)
	}
	response = env.callWithHeaders(t, http.MethodGet, path+"?sessionId="+skillSessionTwo+"&turnId="+turnID, "", headers)
	if response.Code != http.StatusNotFound {
		t.Fatalf("cross-session context %d %s", response.Code, response.Body)
	}
}
