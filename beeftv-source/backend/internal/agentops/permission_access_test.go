package agentops_test

import (
	"encoding/json"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
	"reflect"
	"testing"
)

func accessCanvas(t *testing.T, h *harness, id string) map[string]any {
	t.Helper()
	raw, err := h.service.UserCanvasProject(h.userID, id)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		t.Fatal("document")
	}
	return doc
}
func accessWrite(t *testing.T, h *harness, turn, mode, op, id string, p map[string]any) (agentops.Result, error) {
	t.Helper()
	return h.registry.Execute(agentops.Request{Op: op, OpID: id, UserID: h.userID, TurnID: turn, Caller: agentops.Caller{Kind: agentops.CallerAssistant, Scope: &agentops.AssistantScope{CanvasID: h.canvasID, PermissionMode: mode}}, Params: mustRaw(t, p)})
}

func TestPermissionModePersistenceFreezeAndReadOnlyTransactionGuard(t *testing.T) {
	h := newHarness(t)
	const turn = "acce1234"
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turn, app.AssistantTurnInput{PermissionMode: "read-only"}); err != nil {
		t.Fatal(err)
	}
	runtime, err := h.service.AssistantTurnRuntimeState(h.userID, turn)
	if err != nil || runtime.PermissionMode != "read-only" {
		t.Fatalf("runtime=%+v err=%v", runtime, err)
	}
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turn, app.AssistantTurnInput{PermissionMode: "full-access"}); err == nil {
		t.Fatal("begin upgraded existing turn")
	}
	if err := h.service.ExtendAssistantTurn(h.userID, h.canvasID, turn, app.AssistantTurnInput{PermissionMode: "full-access"}); err == nil {
		t.Fatal("steer upgraded existing turn")
	}
	before := mustJSON(t, h.canvas(t))
	for _, op := range []string{"canvas.node.update", "canvas.timeline.render", "canvas.generation.propose"} {
		_, err := accessWrite(t, h, turn, "read-only", op, "deny-"+op, map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": h.revision, "patch": map[string]any{"title": "bad"}})
		if err == nil {
			t.Fatalf("read-only accepted %s", op)
		}
	}
	// Even a stale preflight or internal caller without a scope cannot bypass persisted mode.
	_, err = h.registry.Execute(agentops.Request{Op: "canvas.node.update", OpID: "bypass", UserID: h.userID, TurnID: turn, Params: mustRaw(t, map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": h.revision, "patch": map[string]any{"title": "bad"}})})
	if err == nil {
		t.Fatal("transaction mode bypass")
	}
	if before != mustJSON(t, h.canvas(t)) || countOpRecords(t, h, "bypass") != 0 {
		t.Fatal("read-only produced a mutation/receipt")
	}
}

func TestFullAccessCrossCanvasReceiptsAndAtomicUndo(t *testing.T) {
	for _, manual := range []bool{false, true} {
		t.Run(map[bool]string{false: "restore-all", true: "manual-interference-refuses-all"}[manual], func(t *testing.T) {
			h := newHarness(t)
			other := "another-canvas"
			doc := h.canvas(t)
			doc["id"] = other
			doc["revision"] = float64(0)
			if _, err := h.service.UpsertUserCanvasProject(h.userID, mustRaw(t, doc)); err != nil {
				t.Fatal(err)
			}
			beforeA, beforeB := accessCanvas(t, h, h.canvasID), accessCanvas(t, h, other)
			const turn = "acce5678"
			if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turn, app.AssistantTurnInput{PermissionMode: "full-access"}); err != nil {
				t.Fatal(err)
			}
			for i, id := range []string{h.canvasID, other} {
				rev := int64(accessCanvas(t, h, id)["revision"].(float64))
				_, err := accessWrite(t, h, turn, "full-access", "canvas.node.move", []string{"move-a", "move-b"}[i], map[string]any{"canvasId": id, "nodeId": "n1", "expectedRevision": rev, "position": map[string]any{"x": 50, "y": 90}})
				if err != nil {
					t.Fatal(err)
				}
			}
			// Retry the original payload, not a new expectedRevision: exactly one effect.
			replay, err := accessWrite(t, h, turn, "full-access", "canvas.node.move", "move-b", map[string]any{"canvasId": other, "nodeId": "n1", "expectedRevision": int64(beforeB["revision"].(float64)), "position": map[string]any{"x": 50, "y": 90}})
			if err != nil || !replay.Replayed {
				t.Fatalf("replay %+v %v", replay, err)
			}
			if err := h.service.FinalizeAssistantTurn(turn); err != nil {
				t.Fatal(err)
			}
			state, err := h.service.ReadAssistantTurnHistoryState(h.userID, h.canvasID, turn)
			if err != nil || len(state.Change.CanvasChanges) != 2 {
				t.Fatalf("changes=%+v err=%v", state, err)
			}
			if state.PermissionMode != "full-access" {
				t.Fatal("history permission missing")
			}
			if manual {
				edited := accessCanvas(t, h, other)
				edited["title"] = "manual"
				if _, err := h.service.UpsertUserCanvasProject(h.userID, mustRaw(t, edited)); err != nil {
					t.Fatal(err)
				}
			}
			writtenA, writtenB := mustJSON(t, accessCanvas(t, h, h.canvasID)), mustJSON(t, accessCanvas(t, h, other))
			_, err = h.service.UndoAssistantTurn(h.userID, h.canvasID, turn)
			if manual {
				if err == nil {
					t.Fatal("manual changes erased")
				}
				if writtenA != mustJSON(t, accessCanvas(t, h, h.canvasID)) || writtenB != mustJSON(t, accessCanvas(t, h, other)) {
					t.Fatal("partial undo")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for id, before := range map[string]map[string]any{h.canvasID: beforeA, other: beforeB} {
				after := accessCanvas(t, h, id)
				for _, field := range []string{"nodes", "connections", "title"} {
					if !reflect.DeepEqual(before[field], after[field]) {
						t.Fatalf("%s not restored: %s", id, field)
					}
				}
			}
		})
	}
}

func TestFullAccessWholeDocumentCommitHasActualDiffAndSafeUndo(t *testing.T) {
	h := newHarness(t)
	const turn = "acce9012"
	before := h.canvas(t)
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turn, app.AssistantTurnInput{PermissionMode: "full-access"}); err != nil {
		t.Fatal(err)
	}
	changed := h.canvas(t)
	changed["title"] = "new title"
	changed["nodes"] = changed["nodes"].([]any)[1:]
	changed["connections"] = []any{}
	changed["custom"] = "new"
	if _, err := accessWrite(t, h, turn, "full-access", "canvas.document.commit", "document-once", map[string]any{"canvasId": h.canvasID, "expectedRevision": h.revision, "document": changed}); err != nil {
		t.Fatal(err)
	}
	if err := h.service.FinalizeAssistantTurn(turn); err != nil {
		t.Fatal(err)
	}
	state, err := h.service.ReadAssistantTurnHistoryState(h.userID, h.canvasID, turn)
	if err != nil || !state.Change.DocumentUpdated || state.Change.DocumentHash == "" || !reflect.DeepEqual(state.Change.DeletedNodeIDs, []string{"n1"}) {
		t.Fatalf("diff=%+v err=%v", state, err)
	}
	if _, err := h.service.UndoAssistantTurn(h.userID, h.canvasID, turn); err != nil {
		t.Fatal(err)
	}
	after := h.canvas(t)
	if !reflect.DeepEqual(before["nodes"], after["nodes"]) || after["custom"] != nil || before["title"] != after["title"] {
		t.Fatal("whole document not restored")
	}
}

func TestBroadModesOwnedReadsAndForeignCanvasStillDenied(t *testing.T) {
	h := newHarness(t)
	if err := h.service.Database().Create(&model.Workspace{ID: "foreign", Name: "foreign"}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := h.service.UpsertUserCanvasProject("foreign", mustRaw(t, map[string]any{"id": "foreign-canvas", "revision": 0, "nodes": []any{}, "connections": []any{}})); err != nil {
		t.Fatal(err)
	}
	const turn = "acce3456"
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turn, app.AssistantTurnInput{PermissionMode: "full-access"}); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{assistantturns.PermissionReadOnly, assistantturns.PermissionFullAccess} {
		scope := &agentops.AssistantScope{CanvasID: h.canvasID, PermissionMode: mode}
		caller := agentops.Caller{Kind: agentops.CallerAssistant, Scope: scope}
		if len(h.registry.List(caller)) < 13 {
			t.Fatal("missing workspace catalog")
		}
		_, err := h.registry.Execute(agentops.Request{Op: "canvas.get", UserID: h.userID, Caller: caller, Params: mustRaw(t, map[string]any{"canvasId": "foreign-canvas"})})
		if err == nil {
			t.Fatal("foreign read allowed")
		}
	}
	_, err := accessWrite(t, h, turn, "full-access", "canvas.nodes.create", "foreign-write", map[string]any{"canvasId": "foreign-canvas", "expectedRevision": 1, "nodes": []any{map[string]any{"title": "bad", "type": "text"}}})
	if err == nil || countOpRecords(t, h, "foreign-write") != 0 {
		t.Fatal("foreign write/receipt allowed")
	}
}
