package operations_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/operations"
)

func editDocument(t *testing.T, h *harness) map[string]any {
	t.Helper()
	raw, err := h.service.UserCanvasProject(h.userID, h.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestCanvasMovePreservesContentAndRejectsStaleOrMissingCoordinates(t *testing.T) {
	h := newHarness(t)
	before := editDocument(t, h)
	params := map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": h.revisionNow(t), "position": map[string]any{"x": 0, "y": -45}}
	first, err := h.execute(t, operations.ExternalCaller(false), "canvas.node.move", "move-once", params)
	if err != nil {
		t.Fatal(err)
	}
	after := editDocument(t, h)
	oldNode := before["nodes"].([]any)[0].(map[string]any)
	newNode := after["nodes"].([]any)[0].(map[string]any)
	if !reflect.DeepEqual(newNode["position"], map[string]any{"x": float64(0), "y": float64(-45)}) {
		t.Fatalf("position: %v", newNode)
	}
	delete(oldNode, "position")
	delete(newNode, "position")
	if !reflect.DeepEqual(oldNode, newNode) {
		t.Fatalf("move changed content: before=%v after=%v", oldNode, newNode)
	}
	replay, err := h.execute(t, operations.ExternalCaller(false), "canvas.node.move", "move-once", params)
	if err != nil || !replay.Replayed || replay.Revision != first.Revision {
		t.Fatalf("replay=%+v err=%v", replay, err)
	}
	if _, err := h.execute(t, operations.ExternalCaller(false), "canvas.node.move", "stale-move", params); err == nil {
		t.Fatal("stale move accepted")
	}
	for i, position := range []map[string]any{{"x": 2}, {"x": 2, "y": 1e8}} {
		params["position"] = position
		params["expectedRevision"] = h.revisionNow(t)
		if _, err := h.execute(t, operations.ExternalCaller(false), "canvas.node.move", []string{"missing-y", "out-of-range"}[i], params); err == nil {
			t.Fatal("invalid position accepted")
		}
	}
}

func TestCanvasDeleteRemovesOnlyTargetAndConnectedEdges(t *testing.T) {
	h := newHarness(t)
	_, err := h.execute(t, operations.ExternalCaller(false), "canvas.edge.create", "edge-for-delete", map[string]any{"canvasId": h.canvasID, "fromNodeId": "n1", "toNodeId": "n2", "expectedRevision": h.revisionNow(t)})
	if err != nil {
		t.Fatal(err)
	}
	before := editDocument(t, h)
	params := map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": h.revisionNow(t)}
	result, err := h.execute(t, operations.ExternalCaller(false), "canvas.node.delete", "delete-once", params)
	if err != nil {
		t.Fatal(err)
	}
	after := editDocument(t, h)
	nodes := after["nodes"].([]any)
	if len(nodes) != 1 || !reflect.DeepEqual(nodes[0], before["nodes"].([]any)[1]) || len(after["connections"].([]any)) != 0 {
		t.Fatalf("delete damaged other node: %v", after)
	}
	replay, err := h.execute(t, operations.ExternalCaller(false), "canvas.node.delete", "delete-once", params)
	if err != nil || !replay.Replayed || replay.Revision != result.Revision {
		t.Fatalf("replay=%+v err=%v", replay, err)
	}
	params["nodeId"] = "foreign-node"
	params["expectedRevision"] = h.revisionNow(t)
	if _, err := h.execute(t, operations.ExternalCaller(false), "canvas.node.delete", "foreign-delete", params); err == nil {
		t.Fatal("foreign node accepted")
	}
	if !reflect.DeepEqual(after, editDocument(t, h)) {
		t.Fatal("failed delete changed document")
	}
}

func TestCanvasEdgeDeletePreservesBothNodesAndReadOnlyDeniesWrites(t *testing.T) {
	h := newHarness(t)
	created, err := h.execute(t, operations.ExternalCaller(false), "canvas.edge.create", "edge-for-unlink", map[string]any{"canvasId": h.canvasID, "fromNodeId": "n1", "toNodeId": "n2", "expectedRevision": h.revisionNow(t)})
	if err != nil {
		t.Fatal(err)
	}
	edgeID := created.Result.(map[string]any)["edgeId"]
	before := editDocument(t, h)
	params := map[string]any{"canvasId": h.canvasID, "edgeId": edgeID, "expectedRevision": h.revisionNow(t)}
	if _, err := h.execute(t, operations.ExternalCaller(true), "canvas.edge.delete", "readonly-unlink", params); err == nil {
		t.Fatal("readonly write accepted")
	}
	if _, err := h.execute(t, operations.ExternalCaller(false), "canvas.edge.delete", "unlink", params); err != nil {
		t.Fatal(err)
	}
	after := editDocument(t, h)
	if len(after["connections"].([]any)) != 0 || !reflect.DeepEqual(before["nodes"], after["nodes"]) {
		t.Fatalf("unlink damaged nodes: %v", after)
	}
}
