package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// Each send carries a client requestId so a Stop can name exactly that request, even
// before the request reaches the host. It is only a stop and resend key: Go still issues
// and authorizes the turn, and the host checks that the session belongs to the canvas.
func TestAssistantChatRequestIDIsValidatedAndNeverReplacesTheTurn(t *testing.T) {
	var forwarded []map[string]any
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/chat" {
				_, _ = w.Write([]byte(`{}`))
				return
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			forwarded = append(forwarded, body)
			turnID, _ := body["turnId"].(string)
			w.Header().Set("Content-Type", "application/x-ndjson")
			_, _ = w.Write([]byte(`{"type":"turn_end","turnId":"` + turnID + `","reply":"ok"}` + "\n"))
		})
	})
	for _, bad := range []string{`""`, `"   "`, `"` + strings.Repeat("a", 129) + `"`, `"has space"`, `"supplement:x"`, `"中文"`, `7`} {
		response := env.call(t, http.MethodPost, "/assistant/chat", `{"canvasId":"`+env.canvasID+`","message":"hi","requestId":`+bad+`}`)
		if response.Code != http.StatusBadRequest || response.Header().Get("X-Beeftv-Turn-Admission") != "rejected" {
			t.Fatalf("requestId %s: want 400 and not admitted, got %d %v %s", bad, response.Code, response.Header(), response.Body.String())
		}
	}
	if len(forwarded) != 0 {
		t.Fatalf("an invalid requestId must not reach the host: %#v", forwarded)
	}
	response := env.call(t, http.MethodPost, "/assistant/chat", `{"canvasId":"`+env.canvasID+`","message":"hi","requestId":"req-1_A","turnId":"client-turn"}`)
	if response.Code != http.StatusOK || len(forwarded) != 1 {
		t.Fatalf("a valid requestId is forwarded: %d %s %#v", response.Code, response.Body.String(), forwarded)
	}
	if forwarded[0]["requestId"] != "req-1_A" {
		t.Fatalf("requestId must reach the host unchanged: %#v", forwarded[0])
	}
	if turnID, _ := forwarded[0]["turnId"].(string); turnID == "" || turnID == "client-turn" || turnID == "req-1_A" {
		t.Fatalf("Go must issue the turn, never the client: %q", turnID)
	}
	legacy := env.call(t, http.MethodPost, "/assistant/chat", `{"canvasId":"`+env.canvasID+`","message":"hi"}`)
	if legacy.Code != http.StatusOK || len(forwarded) != 2 {
		t.Fatalf("a send without requestId still works: %d %s", legacy.Code, legacy.Body.String())
	}
	if _, present := forwarded[1]["requestId"]; present {
		t.Fatalf("Go must not invent a requestId: %#v", forwarded[1])
	}
}

func TestAssistantCancelForwardsOnlyAValidatedRequestTarget(t *testing.T) {
	var forwarded []string
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/cancel" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			raw, _ := io.ReadAll(r.Body)
			forwarded = append(forwarded, string(raw))
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"accepted":true,"state":"pending"}`))
		})
	})
	canvas := `"canvasId":"` + env.canvasID + `"`
	accepted := env.call(t, http.MethodPost, "/assistant/cancel", `{`+canvas+`,"sessionId":"durable:abc","requestId":"req-1","turnId":"forged","extra":true}`)
	if accepted.Code != http.StatusOK {
		t.Fatalf("a targeted stop is accepted: %d %s", accepted.Code, accepted.Body.String())
	}
	if state := decodeEnvelope(t, accepted)["state"]; state != "pending" {
		t.Fatalf("the host's stop state reaches the page, got %v", state)
	}
	if want := `{"canvasId":"` + env.canvasID + `","requestId":"req-1","sessionId":"durable:abc"}`; len(forwarded) != 1 || forwarded[0] != want {
		t.Fatalf("only the validated target is forwarded: %#v", forwarded)
	}
	legacy := env.call(t, http.MethodPost, "/assistant/cancel", `{`+canvas+`}`)
	if legacy.Code != http.StatusOK || len(forwarded) != 2 || forwarded[1] != `{"canvasId":"`+env.canvasID+`"}` {
		t.Fatalf("a stop without a target keeps working: %d %#v", legacy.Code, forwarded)
	}
	for _, bad := range []string{
		`,"requestId":"req-1"`,
		`,"sessionId":"durable:abc"`,
		`,"sessionId":"durable:abc","requestId":""`,
		`,"sessionId":"","requestId":"req-1"`,
		`,"sessionId":"durable:abc","requestId":"` + strings.Repeat("r", 129) + `"`,
		`,"sessionId":"durable:abc","requestId":"bad id"`,
		`,"sessionId":"bad session","requestId":"req-1"`,
		`,"sessionId":"durable:abc","requestId":7`,
	} {
		response := env.call(t, http.MethodPost, "/assistant/cancel", `{`+canvas+bad+`}`)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s: want 400, got %d %s", bad, response.Code, response.Body.String())
		}
	}
	foreign := env.call(t, http.MethodPost, "/assistant/cancel", `{"canvasId":"not-mine","sessionId":"durable:abc","requestId":"req-1"}`)
	if foreign.Code != http.StatusNotFound {
		t.Fatalf("a foreign canvas is 404, got %d", foreign.Code)
	}
	if len(forwarded) != 2 {
		t.Fatalf("rejected stops must not reach the host: %#v", forwarded)
	}
}
