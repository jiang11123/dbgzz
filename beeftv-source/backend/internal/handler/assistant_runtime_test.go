package handler

import (
	"net/http"
	"testing"
)

func TestRuntimeLifecycleRequiresHostAndFencesStoppedTurn(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	const turnID = "aabbccdd00112233"
	env.beginTurn(t, turnID, assistantTurnInput(nil, nil))
	path := "/assistant/runtime/turns/" + turnID
	if got := env.call(t, http.MethodGet, path, ""); got.Code != http.StatusForbidden {
		t.Fatalf("UI obtained host lifecycle capability: %d", got.Code)
	}
	headers := map[string]string{"X-Beeftv-Agent-Token": assistantTestHostToken}
	state := decodeEnvelope(t, env.callWithHeaders(t, http.MethodGet, path, "", headers))
	if state["open"] != true || state["canvasId"] != env.canvasID {
		t.Fatalf("bad resumable state %#v", state)
	}
	for range 2 {
		state = decodeEnvelope(t, env.callWithHeaders(t, http.MethodPost, path+"/complete", "{}", headers))
		if state["open"] != false {
			t.Fatalf("completion not idempotent %#v", state)
		}
	}
	if status, _ := env.opsRaw("canvas.node.update", "after-stop", turnID, `{"canvasId":"`+env.canvasID+`","nodeId":"n1","expectedRevision":1,"patch":{"title":"must not write"}}`); status != http.StatusForbidden {
		t.Fatalf("stopped turn still writable: %d", status)
	}
	if got := env.callWithHeaders(t, http.MethodGet, "/assistant/runtime/turns/deadbeef", "", headers); got.Code != http.StatusForbidden {
		t.Fatalf("unknown task admitted %d", got.Code)
	}
}

func TestTerminalLineRequiresMatchingBusinessTurn(t *testing.T) {
	for _, line := range []string{`{"type":"turn_end"}`, `{"type":"turn_end","turnId":"foreign"}`, `{"type":"text_delta","turnId":"owned"}`} {
		if assistantTerminalLine([]byte(line), "owned") {
			t.Fatalf("false completion %s", line)
		}
	}
	if !assistantTerminalLine([]byte(`{"type":"turn_end","turnId":"owned"}`), "owned") {
		t.Fatal("completion receipt rejected")
	}
}
