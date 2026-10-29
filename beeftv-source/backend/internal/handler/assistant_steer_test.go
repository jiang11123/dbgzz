package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestAssistantSteerScopeAndNoNewTurn(t *testing.T) {
	hits := 0
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/steer" {
				t.Errorf("unexpected host route %s", r.URL.Path)
				return
			}
			hits++
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["canvasId"] != env.canvasID || body["sessionId"] != "s1" || body["message"] != "只改结尾" || len(body) != 3 {
				t.Errorf("bad scope %#v", body)
			}
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"accepted":true}`))
		})
	})
	body := `{"canvasId":"` + env.canvasID + `","sessionId":"s1","message":"只改结尾"}`
	rejected := env.callWithHeaders(t, http.MethodPost, "/assistant/steer", body, map[string]string{"X-Beeftv-Ui-Session": "expired"})
	if rejected.Code != http.StatusForbidden || hits != 0 {
		t.Fatalf("unauthorized forwarded: %d hits=%d", rejected.Code, hits)
	}
	for _, bad := range []string{
		`{"canvasId":"missing","sessionId":"s1","message":"x"}`,
		`{"canvasId":"` + env.canvasID + `","message":"x"}`,
		`{"canvasId":"` + env.canvasID + `","sessionId":"s1","message":" "}`,
		`{"canvasId":"` + env.canvasID + `","sessionId":"s1","message":"x","references":[{"kind":"asset","id":"other"}]}`,
		`{"canvasId":"` + env.canvasID + `","sessionId":"s1","message":"` + strings.Repeat("x", 20001) + `"}`,
	} {
		resp := env.call(t, http.MethodPost, "/assistant/steer", bad)
		if resp.Code < 400 || hits != 0 {
			t.Fatalf("invalid supplement forwarded: %d hits=%d", resp.Code, hits)
		}
	}
	resp := env.call(t, http.MethodPost, "/assistant/steer", body)
	if resp.Code != http.StatusOK || hits != 1 || !strings.Contains(resp.Body.String(), `"accepted":true`) {
		t.Fatalf("accepted supplement missing: %d %s hits=%d", resp.Code, resp.Body.String(), hits)
	}
}
