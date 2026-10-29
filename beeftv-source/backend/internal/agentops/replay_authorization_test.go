package agentops_test

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/agentops"
)

func TestReplayStillRequiresWriteCapabilityAndMatchingOperation(t *testing.T) {
	h := newHarness(t)
	params := map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": h.revision,
		"patch": map[string]any{"title": "Committed title"}}
	first, err := h.run(t, "canvas.node.update", "authorized-write", params, false)
	if err != nil {
		t.Fatal(err)
	}
	before := mustJSON(t, h.canvas(t))
	for _, tc := range []struct {
		name, op string
		readOnly bool
		code     agentops.Code
		reason   string
	}{
		{"read-only-replay", "canvas.node.update", true, agentops.CodeReadOnly, "read_only_client"},
		{"different-operation", "canvas.nodes.create", false, agentops.CodeConflict, "operation_id_reused_with_different_payload"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := h.run(t, tc.op, "authorized-write", params, tc.readOnly)
			if got := opCode(t, err); got != tc.code || agentops.AsError(err).Reason != tc.reason {
				t.Fatalf("got %v; want %s/%s", err, tc.code, tc.reason)
			}
		})
	}
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.registry.Execute(agentops.Request{Op: "canvas.node.update", OpID: "authorized-write", Params: raw})
	if got := opCode(t, err); got != agentops.CodeInvalidArgument || agentops.AsError(err).Reason != "missing_scope" {
		t.Fatalf("missing identity replay: %v", err)
	}
	if after := mustJSON(t, h.canvas(t)); after != before {
		t.Fatal("denied replay mutated canvas")
	}
	replay, err := h.run(t, "canvas.node.update", "authorized-write", params, false)
	if err != nil {
		t.Fatal(err)
	}
	if !replay.Replayed || mustJSON(t, replay.Result) != mustJSON(t, first.Result) {
		t.Fatal("denied attempts changed original replay result")
	}
}
