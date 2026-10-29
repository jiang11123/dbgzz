package handler

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestAssistantHistoryRecoversCommittedChangeWithoutHostTurnEnd(t *testing.T) {
	var turnID string
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/history" {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"sessionId": "interrupted-session", "turns": []any{map[string]any{"turnId": turnID, "userText": "edit", "reply": "", "change": nil, "error": "interrupted", "errorReason": "turn_interrupted"}}})
				return
			}
			if r.URL.Path != "/chat" {
				w.WriteHeader(404)
				return
			}
			var body struct {
				TurnID         string `json:"turnId"`
				RevisionBefore int64  `json:"revisionBefore"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			turnID = body.TurnID
			params, _ := json.Marshal(map[string]any{"canvasId": env.canvasID, "nodeId": "n1", "expectedRevision": body.RevisionBefore, "patch": map[string]any{"title": "written before interruption"}})
			status, result := env.opsRaw("canvas.node.update", "interrupted-history-operation", turnID, string(params))
			if status != 200 {
				t.Errorf("write failed: %d %s", status, result)
				w.WriteHeader(500)
				return
			}
			w.Header().Set("Content-Type", "application/x-ndjson")
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "text_delta", "delta": "working"})
			// Simulate stream ending after a committed operation and before the host final event.
		})
	})
	response := env.call(t, http.MethodPost, "/assistant/chat", `{"canvasId":"`+env.canvasID+`","message":"edit"}`)
	if response.Code != 200 || turnID == "" {
		t.Fatalf("chat failed: %d %s", response.Code, response.Body.String())
	}
	history := decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/history?canvasId="+env.canvasID, ""))
	turns, _ := history["turns"].([]any)
	if len(turns) != 1 {
		t.Fatalf("interrupted turn missing: %#v", history)
	}
	change, ok := turns[0].(map[string]any)["change"].(map[string]any)
	if !ok || change["revisionAfter"] == nil {
		t.Fatalf("history ignored durable business receipt: %#v", history)
	}
	undo := env.call(t, http.MethodPost, "/assistant/turns/"+turnID+"/undo", `{"canvasId":"`+env.canvasID+`"}`)
	if undo.Code != 200 {
		t.Fatalf("recovered turn could not undo: %d %s", undo.Code, undo.Body.String())
	}
}
