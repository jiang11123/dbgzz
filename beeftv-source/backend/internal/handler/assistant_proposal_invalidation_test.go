package handler

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestAssistantProposalInvalidationUsesDurableIntentOnHistoryTerminalAndRun(t *testing.T) {
	const session = "durable:11111111-2222-3333-4444-555555555555"
	var ids []string
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/history":
				turns := []any{map[string]any{"turnId": "deadbeefdeadbeef", "proposalsInvalidated": true}}
				for _, id := range ids {
					// The host deliberately claims the opposite of the business receipt.
					turns = append(turns, map[string]any{"turnId": id, "proposalsInvalidated": id == ids[len(ids)-1]})
				}
				json.NewEncoder(w).Encode(map[string]any{"sessionId": session, "turns": turns})
			case "/steer":
				json.NewEncoder(w).Encode(map[string]any{"accepted": true})
			case "/chat":
				var body map[string]any
				json.NewDecoder(r.Body).Decode(&body)
				id := body["turnId"].(string)
				ids = append(ids, id)
				owner, _ := env.service.LocalWorkspaceOwner()
				if err := env.service.BindAssistantDurableSession(owner.ID, id, session, false); err != nil {
					t.Error(err)
				}
				w.Header().Set("Content-Type", "application/x-ndjson")
				json.NewEncoder(w).Encode(map[string]any{"type": "turn_end", "turnId": id, "sessionId": session, "reply": "方案已准备好", "proposalsInvalidated": true})
			default:
				w.WriteHeader(404)
			}
		})
	})
	body := `{"canvasId":"` + env.canvasID + `","sessionId":"` + session + `","message":"制作一张图片"}`
	run := func(id string, want int) {
		t.Helper()
		response := env.call(t, http.MethodPost, "/assistant/turns/"+id+"/proposals/gp-fixture/run", `{"canvasId":"`+env.canvasID+`"}`)
		if response.Code != want {
			t.Fatalf("run %s: %d %s", id, response.Code, response.Body.String())
		}
		if want == 409 {
			var failure map[string]any
			json.Unmarshal(response.Body.Bytes(), &failure)
			if failure["reason"] != "continuation_intent_changed" {
				t.Fatal(failure)
			}
		}
	}
	for i := 0; i < 2; i++ {
		response := env.call(t, http.MethodPost, "/assistant/chat", body)
		if response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
		var terminal map[string]any
		json.Unmarshal(response.Body.Bytes(), &terminal)
		if terminal["proposalsInvalidated"] != false {
			t.Fatal("current terminal must replace host's forged flag", terminal)
		}
		run(ids[i], 200)
		if i == 0 {
			steer := env.call(t, http.MethodPost, "/assistant/steer", body)
			if steer.Code != 200 {
				t.Fatal(steer.Code, steer.Body.String())
			}
			run(ids[0], 200) // A supplement is not a new intent.
		}
	}
	// No continuation was armed: this gate also protects users who disabled it.
	run(ids[0], 409)
	run(ids[1], 200)
	history := env.call(t, http.MethodGet, "/assistant/history?canvasId="+env.canvasID+"&sessionId="+session, "")
	if history.Code != 200 {
		t.Fatal(history.Code, history.Body.String())
	}
	turns := decodeEnvelope(t, history)["turns"].([]any)
	if _, supplied := turns[0].(map[string]any)["proposalsInvalidated"]; supplied {
		t.Fatal("unowned host field survived", turns[0])
	}
	if turns[1].(map[string]any)["proposalsInvalidated"] != true || turns[2].(map[string]any)["proposalsInvalidated"] != false {
		t.Fatal("history lost the durable intent fence", turns)
	}
	owner, _ := env.service.LocalWorkspaceOwner()
	line, _ := json.Marshal(map[string]any{"type": "turn_end", "turnId": ids[0], "proposalsInvalidated": false})
	var recovered map[string]any
	json.Unmarshal(assistantOutputsLine(line, env.service, owner.ID, env.canvasID, ids[0]), &recovered)
	if recovered["proposalsInvalidated"] != true {
		t.Fatal("replayed terminal revived old proposal", recovered)
	}
}
