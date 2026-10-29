package agentops_test

import (
	"errors"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"reflect"
	"testing"
)

// Assistant-created media only counts toward storyboard progress once a row binds it.
// Binding goes through row.update; bad targets and stale revisions write nothing.
func TestStoryboardRowUpdateBindsOutputNodesAndUndoRestores(t *testing.T) {
	h := newHarness(t)
	doc := h.canvas(t)
	nodes := doc["nodes"].([]any)
	script := nodes[0].(map[string]any)
	script["type"] = "script"
	script["metadata"] = map[string]any{"storyboard": map[string]any{"rows": []any{
		map[string]any{"id": "shot-a", "shotNumber": 1, "dialogue": "a", "imageNodeId": "n2"},
		map[string]any{"id": "shot-b", "shotNumber": 2, "dialogue": "b", "videoNodeId": "vid-b"},
	}}}
	doc["nodes"] = append(nodes,
		map[string]any{"id": "img-new", "type": "image", "position": map[string]any{"x": 10, "y": 10}},
		map[string]any{"id": "vid", "type": "video", "position": map[string]any{"x": 20, "y": 20}},
		map[string]any{"id": "vid-b", "type": "video", "position": map[string]any{"x": 30, "y": 30}},
		map[string]any{"id": "txt", "type": "text", "position": map[string]any{"x": 40, "y": 40}},
	)
	doc["connections"] = append(doc["connections"].([]any),
		map[string]any{"id": "out-old", "fromNodeId": "n1", "toNodeId": "n2", "fromHandleId": "row:shot-a", "relation": "storyboard-output", "storyboardRowId": "shot-a"},
		map[string]any{"id": "ref-a", "fromNodeId": "txt", "toNodeId": "n2", "relation": "storyboard-asset-reference", "storyboardRowId": "shot-a"},
		map[string]any{"id": "out-b", "fromNodeId": "n1", "toNodeId": "vid-b", "fromHandleId": "row:shot-b", "relation": "storyboard-output", "storyboardRowId": "shot-b"},
	)
	if _, err := h.service.UpsertUserCanvasProject(h.userID, mustRaw(t, doc)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.service.UpsertUserCanvasProject(h.userID, mustRaw(t, map[string]any{"id": "other-canvas", "revision": 0, "title": "other",
		"nodes": []any{map[string]any{"id": "foreign-img", "type": "image", "position": map[string]any{"x": 0, "y": 0}}}, "connections": []any{}})); err != nil {
		t.Fatal(err)
	}
	before := h.canvas(t)
	const turn = "b1d0b1d0"
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turn, app.AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	update := func(id string, revision any, patches ...map[string]any) (map[string]any, error) {
		items := make([]any, 0, len(patches))
		for _, patch := range patches {
			items = append(items, patch)
		}
		result, err := accessWrite(t, h, turn, "canvas", "canvas.script.row.update", id,
			map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": revision, "patches": items})
		if err != nil {
			return nil, err
		}
		return result.Result.(map[string]any), nil
	}
	receipt, err := update("bind", before["revision"], map[string]any{"rowId": "shot-a", "imageNodeId": "img-new", "videoNodeId": "vid"})
	if err != nil {
		t.Fatal(err)
	}
	created := stringList(receipt["createdEdgeIds"])
	if len(created) != 2 || !reflect.DeepEqual(stringList(receipt["deletedEdgeIds"]), []string{"out-old"}) {
		t.Fatalf("bind receipt: %#v", receipt)
	}
	bound := h.canvas(t)
	rows := bound["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["storyboard"].(map[string]any)["rows"].([]any)
	if row := rows[0].(map[string]any); row["imageNodeId"] != "img-new" || row["videoNodeId"] != "vid" || row["dialogue"] != "a" {
		t.Fatalf("bound row: %#v", row)
	}
	if !reflect.DeepEqual(rows[1], before["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["storyboard"].(map[string]any)["rows"].([]any)[1]) {
		t.Fatalf("untouched row changed: %#v", rows[1])
	}
	connections := bound["connections"].([]any)
	if len(connections) != 5 || connections[0].(map[string]any)["id"] != "e1" || connections[1].(map[string]any)["id"] != "ref-a" || connections[2].(map[string]any)["id"] != "out-b" {
		t.Fatalf("unrelated edges not preserved: %#v", connections)
	}
	for index, target := range []string{"img-new", "vid"} {
		want := map[string]any{"id": created[index], "fromNodeId": "n1", "toNodeId": target, "fromHandleId": "row:shot-a", "relation": "storyboard-output", "storyboardRowId": "shot-a"}
		if !reflect.DeepEqual(connections[3+index], want) {
			t.Fatalf("output edge %d = %#v", index, connections[3+index])
		}
	}

	settled := mustJSON(t, bound)
	for id, test := range map[string]struct {
		revision any
		reason   string
		patches  []map[string]any
	}{
		"wrong-type":    {bound["revision"], "node_kind_mismatch", []map[string]any{{"rowId": "shot-a", "imageNodeId": "vid"}}},
		"missing":       {bound["revision"], "node_not_in_canvas", []map[string]any{{"rowId": "shot-a", "videoNodeId": "ghost"}}},
		"cross-canvas":  {bound["revision"], "node_not_in_canvas", []map[string]any{{"rowId": "shot-a", "imageNodeId": "foreign-img"}}},
		"script-target": {bound["revision"], "node_kind_mismatch", []map[string]any{{"rowId": "shot-a", "videoNodeId": "n1"}}},
		"partial-batch": {bound["revision"], "node_kind_mismatch", []map[string]any{{"rowId": "shot-b", "dialogue": "changed"}, {"rowId": "shot-a", "imageNodeId": "txt"}}},
		"stale":         {before["revision"], "stale_revision", []map[string]any{{"rowId": "shot-a", "imageNodeId": "n2"}}},
	} {
		_, err := update(id, test.revision, test.patches...)
		var opErr *agentops.Error
		if !errors.As(err, &opErr) || opErr.Reason != test.reason {
			t.Fatalf("%s: want %s, got %v", id, test.reason, err)
		}
		if mustJSON(t, h.canvas(t)) != settled || countOpRecords(t, h, id) != 0 {
			t.Fatalf("%s wrote canvas or receipt", id)
		}
	}

	receipt, err = update("unbind", bound["revision"], map[string]any{"rowId": "shot-a", "videoNodeId": ""})
	if err != nil {
		t.Fatal(err)
	}
	if len(stringList(receipt["createdEdgeIds"])) != 0 || !reflect.DeepEqual(stringList(receipt["deletedEdgeIds"]), []string{created[1]}) {
		t.Fatalf("unbind receipt: %#v", receipt)
	}
	unbound := h.canvas(t)
	row := unbound["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["storyboard"].(map[string]any)["rows"].([]any)[0].(map[string]any)
	if _, exists := row["videoNodeId"]; exists || row["imageNodeId"] != "img-new" || len(unbound["connections"].([]any)) != 4 {
		t.Fatalf("unbind left binding or edge: %#v %#v", row, unbound["connections"])
	}

	if err := h.service.FinalizeAssistantTurn(turn); err != nil {
		t.Fatal(err)
	}
	state, err := h.service.ReadAssistantTurnHistoryState(h.userID, h.canvasID, turn)
	if err != nil || state == nil || state.Change == nil {
		t.Fatalf("missing change: %+v %v", state, err)
	}
	wantDeleted := []string{created[1], "out-old"}
	if created[1] > "out-old" {
		wantDeleted = []string{"out-old", created[1]}
	}
	if !reflect.DeepEqual(state.Change.UpdatedNodeIDs, []string{"n1"}) || !reflect.DeepEqual(state.Change.CreatedEdgeIDs, created) || !reflect.DeepEqual(state.Change.DeletedEdgeIDs, wantDeleted) {
		t.Fatalf("change accounting: %+v", state.Change)
	}
	if _, err := h.service.UndoAssistantTurn(h.userID, h.canvasID, turn); err != nil {
		t.Fatal(err)
	}
	restored := h.canvas(t)
	if !reflect.DeepEqual(before["nodes"], restored["nodes"]) || !reflect.DeepEqual(before["connections"], restored["connections"]) {
		t.Fatal("undo did not restore rows and output edges")
	}
}

func stringList(raw any) []string {
	items, _ := raw.([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func TestStoryboardOperationsReceiptReplayAndUndo(t *testing.T) {
	for _, op := range []string{"canvas.script.rows.append", "canvas.script.row.update", "canvas.script.row.remove"} {
		t.Run(op, func(t *testing.T) {
			h := newHarness(t)
			doc := h.canvas(t)
			node := doc["nodes"].([]any)[0].(map[string]any)
			node["type"] = "script"
			node["metadata"] = map[string]any{"storyboard": map[string]any{"rows": []any{map[string]any{"id": "shot-original", "shotNumber": 1, "dialogue": "original"}}}}
			doc["nodes"] = append(doc["nodes"].([]any), map[string]any{"id": "target", "type": "image", "position": map[string]any{"x": 100, "y": 100}})
			doc["connections"] = []any{
				map[string]any{"id": "row-edge", "fromNodeId": "n1", "toNodeId": "target", "fromHandleId": "row:shot-original"},
				map[string]any{"id": "row-in", "fromNodeId": "target", "toNodeId": "n1", "toHandleId": "row:shot-original"},
				map[string]any{"id": "row-tag", "fromNodeId": "n1", "toNodeId": "target", "storyboardRowId": "shot-original"},
				map[string]any{"id": "keep-edge", "fromNodeId": "n1", "toNodeId": "target"},
			}
			if _, err := h.service.UpsertUserCanvasProject(h.userID, mustRaw(t, doc)); err != nil {
				t.Fatal(err)
			}
			before := h.canvas(t)
			const turn = "abcd9988"
			if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turn, app.AssistantTurnInput{}); err != nil {
				t.Fatal(err)
			}
			p := map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": before["revision"]}
			switch op {
			case "canvas.script.rows.append":
				p["rows"] = []any{map[string]any{"dialogue": "new"}}
			case "canvas.script.row.update":
				p["patches"] = []any{map[string]any{"rowId": "shot-original", "dialogue": "new"}}
			case "canvas.script.row.remove":
				p["rowIds"] = []string{"shot-original"}
			}
			if _, err := accessWrite(t, h, turn, "canvas", op, "story-write", p); err != nil {
				t.Fatal(err)
			}
			result, err := accessWrite(t, h, turn, "canvas", op, "story-write", p)
			if err != nil || !result.Replayed {
				t.Fatalf("replay: %+v %v", result, err)
			}
			if err := h.service.FinalizeAssistantTurn(turn); err != nil {
				t.Fatal(err)
			}
			state, err := h.service.ReadAssistantTurnHistoryState(h.userID, h.canvasID, turn)
			if err != nil || state == nil || state.Change == nil || !reflect.DeepEqual(state.Change.UpdatedNodeIDs, []string{"n1"}) {
				t.Fatalf("missing node change: %+v %v", state, err)
			}
			if op == "canvas.script.row.remove" {
				if !reflect.DeepEqual(state.Change.DeletedEdgeIDs, []string{"row-edge", "row-in", "row-tag"}) || len(h.canvas(t)["connections"].([]any)) != 1 {
					t.Fatal("removed row left dangling edges or deleted unrelated edges")
				}
			}
			if _, err := h.service.UndoAssistantTurn(h.userID, h.canvasID, turn); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before["nodes"], h.canvas(t)["nodes"]) {
				t.Fatal("storyboard not restored")
			}
			if !reflect.DeepEqual(before["connections"], h.canvas(t)["connections"]) {
				t.Fatal("undo did not restore row connections")
			}
		})
	}
}
