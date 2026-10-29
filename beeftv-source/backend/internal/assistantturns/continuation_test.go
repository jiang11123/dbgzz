package assistantturns_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

const continuationSource = "aabbccdd00112233"

func continuationFixture(t *testing.T, kind string) (*turnFixture, *assistantturns.ContinuationView) {
	t.Helper()
	fx := openTurnFixture(t)
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, continuationSource, assistantturns.Input{PermissionMode: assistantturns.PermissionCanvas}); err != nil {
		t.Fatal(err)
	}
	if err := fx.turns.BindDurableSession(fx.userID, continuationSource, contextSession, false); err != nil {
		t.Fatal(err)
	}
	doc := fx.readCanvas(t)
	doc["nodes"] = append(doc["nodes"].([]any), map[string]any{"id": "source", "type": kind, "title": "镜头", "position": map[string]any{"x": 10, "y": 10}, "metadata": map[string]any{}})
	after := fx.writeCanvas(t, doc)
	fx.receipt(t, continuationSource, "create-source", "canvas.nodes.create", map[string]any{"canvasId": fx.canvasID, "revision": after, "created": []any{map[string]any{"id": "source"}}})
	if err := fx.turns.Finalize(continuationSource); err != nil {
		t.Fatal(err)
	}
	row, err := fx.turns.ArmContinuation(fx.userID, assistantturns.ContinuationInput{CanvasID: fx.canvasID, SessionID: contextSession, SourceTurnID: continuationSource, ProposalID: "gp-fixture", Kind: kind, NodeIDs: []string{"source"}})
	if err != nil {
		t.Fatal(err)
	}
	return fx, row
}

func continuationManifest(t *testing.T, fx *turnFixture, row *assistantturns.ContinuationView, native bool, targets ...string) assistantturns.ContinuationManifest {
	t.Helper()
	manifest := assistantturns.ContinuationManifest{SourceNodeID: "source"}
	prefix := "proposal:gp-fixture:source"
	if native || len(targets) == 1 {
		manifest.Submissions = []assistantturns.ContinuationSubmission{{OperationID: prefix, OutputNodeIDs: targets}}
	} else {
		for i, id := range targets {
			manifest.Submissions = append(manifest.Submissions, assistantturns.ContinuationSubmission{OperationID: fmt.Sprintf("%s:%d", prefix, i), OutputNodeIDs: []string{id}})
		}
	}
	if err := fx.turns.RegisterContinuationManifest(fx.userID, row.ID, manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func continuationTask(t *testing.T, fx *turnFixture, row *assistantturns.ContinuationView, submission assistantturns.ContinuationSubmission, id, status string, delivered bool) {
	t.Helper()
	input, _ := json.Marshal(map[string]any{"metadata": map[string]any{"sourceNodeId": "source", "nodeId": submission.OutputNodeIDs[0], "outputNodeIds": submission.OutputNodeIDs}})
	task := model.Task{ID: id, UserID: fx.userID, ProjectID: fx.canvasID, ClientOperationID: &submission.OperationID, Type: "canvas_" + row.Kind, Status: model.TaskStatus(status), InputJSON: string(input)}
	if err := fx.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	doc := fx.readCanvas(t)
	nodes := doc["nodes"].([]any)
	for i, nodeID := range submission.OutputNodeIDs {
		meta := map[string]any{"taskId": id, "taskStatus": status, "status": "error"}
		if status == "succeeded" {
			meta["status"] = "success"
			meta["storageKey"] = "resource:" + id + fmt.Sprint(i)
			resource := model.Resource{ID: id + fmt.Sprint(i), UserID: fx.userID, Status: model.ResourceStatusReady}
			if err := fx.db.Create(&resource).Error; err != nil {
				t.Fatal(err)
			}
			assetID := "asset-" + resource.ID
			asset, _ := json.Marshal(map[string]any{"id": assetID, "kind": row.Kind, "title": "生成结果", "coverUrl": "", "source": "生成任务", "tags": []any{}, "status": "confirmed", "data": map[string]any{"dataUrl": "", "url": "", "storageKey": "resource:" + resource.ID, "width": 1, "height": 1, "bytes": 1, "mimeType": "image/png"}})
			if _, err := fx.canvas.UpsertUserAsset(fx.userID, asset); err != nil {
				t.Fatal(err)
			}
			meta["assetId"] = assetID
			if delivered {
				payload, _ := json.Marshal(localtask.BindOutput(localtask.CanonicalOutput{OutputIndex: i, MediaType: row.Kind, ResourceID: resource.ID}, task.ID, localtask.TargetBindingFromInput(task.InputJSON)))
				if err := fx.db.Create(&model.Result{ID: id + fmt.Sprint(i), UserID: fx.userID, TaskID: id, Kind: localtask.ResultKindGenerationOutput, Payload: string(payload)}).Error; err != nil {
					t.Fatal(err)
				}
			}
		}
		found := false
		for _, value := range nodes {
			n := value.(map[string]any)
			if n["id"] == nodeID {
				n["metadata"] = meta
				found = true
			}
		}
		if !found {
			nodes = append(nodes, map[string]any{"id": nodeID, "type": row.Kind, "position": map[string]any{"x": 20, "y": 20}, "metadata": meta})
		}
	}
	doc["nodes"] = nodes
	fx.writeCanvas(t, doc)
}

func TestContinuationStableClaimUsesRealOutputsAndSurvivesReopen(t *testing.T) {
	for _, kind := range []string{"image", "video"} {
		t.Run(kind, func(t *testing.T) {
			fx, row := continuationFixture(t, kind)
			manifest := continuationManifest(t, fx, row, true, "source")
			_, err := fx.turns.ClaimContinuation(fx.userID, row.ID, nil)
			contextReason(t, err, "continuation_waiting")
			continuationTask(t, fx, row, manifest.Submissions[0], "task-one", "succeeded", true)
			first, err := fx.turns.ClaimContinuation(fx.userID, row.ID, nil)
			if err != nil {
				t.Fatal(err)
			}
			reopened := fx.reopen(t)
			second, err := reopened.turns.ClaimContinuation(fx.userID, row.ID, nil)
			if err != nil {
				t.Fatal(err)
			}
			if first.TurnID != second.TurnID || first.RequestID != second.RequestID || !reflect.DeepEqual(second.TaskIDs, []string{"task-one"}) || !reflect.DeepEqual(second.SelectedNodeIDs, []string{"source"}) {
				t.Fatalf("unstable claim %+v %+v", first, second)
			}
			rec, err := reopened.turns.Load(first.TurnID)
			if err != nil || rec.DurableSessionID != contextSession || rec.PermissionMode != assistantturns.PermissionCanvas {
				t.Fatalf("bad turn %+v %v", rec, err)
			}
			if err := reopened.turns.VerifyContinuation(fx.userID, row.ID, row.TurnID, contextSession); err != nil {
				t.Fatal(err)
			}
			if err := reopened.turns.Finalize(row.TurnID); err != nil {
				t.Fatal(err)
			}
			rows, err := reopened.turns.ListContinuations(fx.userID, fx.canvasID, contextSession)
			if err != nil || len(rows) != 0 {
				t.Fatalf("finished still queued %+v %v", rows, err)
			}
		})
	}
}

func TestContinuationCancellationBeforeArmInvalidatesSourceIntent(t *testing.T) {
	for _, event := range []string{"stop", "new-message", "switch-session", "new-scope", "clear", "selection"} {
		t.Run(event, func(t *testing.T) {
			fx, row := continuationFixture(t, "image")
			// The source turn exists, but its confirmation is still preparing and
			// has not persisted an automatic-continuation receipt yet.
			if err := fx.db.Delete(&model.AssistantContinuation{}, "id = ?", row.ID).Error; err != nil {
				t.Fatal(err)
			}
			stale, err := fx.repo.AssistantTurnByID(nil, continuationSource)
			if err != nil {
				t.Fatal(err)
			}
			if event == "new-scope" || event == "clear" || event == "selection" {
				ctx, err := fx.turns.SkillContext(fx.userID, fx.canvasID, contextSession)
				if err != nil {
					t.Fatal(err)
				}
				action := map[string]string{"new-scope": "new_scope", "clear": "clear", "selection": "activate"}[event]
				ctx, err = fx.turns.ChangeSkillContext(fx.userID, fx.canvasID, assistantturns.SkillContextChange{SessionID: contextSession, Action: action, ExpectedRevision: ctx.Revision, RequestID: event})
				if err != nil {
					t.Fatal(err)
				}
				if event == "new-scope" {
					if _, err = fx.turns.AcknowledgeSkillScope(fx.userID, fx.canvasID, contextSession, ctx.ScopeID, ctx.Revision); err != nil {
						t.Fatal(err)
					}
				}
			} else {
				session := contextSession
				if event == "switch-session" {
					session = ""
				}
				if err := fx.turns.CancelContinuations(fx.userID, fx.canvasID, session, event != "stop"); err != nil {
					t.Fatal(err)
				}
			}
			// A delayed save of the original record cannot erase the permanent fence.
			if err := fx.repo.SaveAssistantTurn(nil, stale); err != nil {
				t.Fatal(err)
			}
			// Reopen proves the authority fence is durable, rather than a UI flag.
			fx = fx.reopen(t)
			_, err = fx.turns.ArmContinuation(fx.userID, assistantturns.ContinuationInput{CanvasID: fx.canvasID, SessionID: contextSession, SourceTurnID: continuationSource, ProposalID: "gp-fixture", Kind: "image", NodeIDs: []string{"source"}})
			contextReason(t, err, "continuation_intent_changed")
			var count int64
			fx.db.Model(&model.AssistantContinuation{}).Count(&count)
			if count != 0 {
				t.Fatal("late confirmation resurrected", count)
			}
			fresh := "aabbccdd00112244"
			if _, err = fx.turns.Begin(fx.userID, fx.canvasID, fresh, assistantturns.Input{PermissionMode: assistantturns.PermissionCanvas}); err != nil {
				t.Fatal(err)
			}
			if err = fx.turns.BindDurableSession(fx.userID, fresh, contextSession, false); err != nil {
				t.Fatal(err)
			}
			if err = fx.turns.Finalize(fresh); err != nil {
				t.Fatal(err)
			}
			if _, err = fx.turns.ArmContinuation(fx.userID, assistantturns.ContinuationInput{CanvasID: fx.canvasID, SessionID: contextSession, SourceTurnID: fresh, ProposalID: "gp-fresh", Kind: "image", NodeIDs: []string{"source"}}); err != nil {
				t.Fatal("new intent must remain usable", err)
			}
		})
	}
}

func TestContinuationNativeAndSplitWaitForCompleteImmutableSet(t *testing.T) {
	for _, native := range []bool{false, true} {
		t.Run(fmt.Sprint(native), func(t *testing.T) {
			fx, row := continuationFixture(t, "image")
			manifest := continuationManifest(t, fx, row, native, "out-a", "out-b")
			if err := fx.turns.RegisterContinuationManifest(fx.userID, row.ID, manifest); err != nil {
				t.Fatal(err)
			}
			changed := manifest
			changed.Submissions = append([]assistantturns.ContinuationSubmission{}, manifest.Submissions...)
			changed.Submissions[0].OutputNodeIDs = []string{"out-a"}
			if native {
				contextReason(t, fx.turns.RegisterContinuationManifest(fx.userID, row.ID, changed), "continuation_conflict")
			}
			if native {
				continuationTask(t, fx, row, manifest.Submissions[0], "native", "succeeded", true)
			} else {
				continuationTask(t, fx, row, manifest.Submissions[0], "split-a", "succeeded", true)
				continuationTask(t, fx, row, manifest.Submissions[1], "split-b", "running", false)
				_, err := fx.turns.ClaimContinuation(fx.userID, row.ID, nil)
				contextReason(t, err, "continuation_waiting")
				rows, err := fx.turns.ListContinuations(fx.userID, fx.canvasID, contextSession)
				if err != nil || len(rows) != 1 || len(rows[0].TaskIDs) != 2 {
					t.Fatalf("task subscription loses complete set %+v %v", rows, err)
				}
			}
			doc := fx.readCanvas(t)
			nodes := []any{}
			for _, n := range doc["nodes"].([]any) {
				if n.(map[string]any)["id"] != "out-b" {
					nodes = append(nodes, n)
				}
			}
			doc["nodes"] = nodes
			fx.writeCanvas(t, doc)
			if !native {
				fx.db.Model(&model.Task{}).Where("id = ?", "split-b").Update("status", "failed")
			}
			_, err := fx.turns.ClaimContinuation(fx.userID, row.ID, nil)
			contextReason(t, err, "continuation_target_changed")
		})
	}
}

func TestContinuationDoesNotConfuseSuccessWithDeliveryOrUnrelatedMedia(t *testing.T) {
	fx, row := continuationFixture(t, "image")
	manifest := continuationManifest(t, fx, row, true, "source")
	continuationTask(t, fx, row, manifest.Submissions[0], "task", "succeeded", false)
	_, err := fx.turns.ClaimContinuation(fx.userID, row.ID, nil)
	contextReason(t, err, "continuation_waiting")
	payload, _ := json.Marshal(localtask.CanonicalOutput{OutputIndex: 0, MediaType: "image", ResourceID: "actual", TargetBinding: &localtask.TargetBinding{NodeID: "source"}})
	fx.db.Create(&model.Result{ID: "result", UserID: fx.userID, TaskID: "task", Kind: localtask.ResultKindGenerationOutput, Payload: string(payload)})
	_, err = fx.turns.ClaimContinuation(fx.userID, row.ID, nil)
	contextReason(t, err, "continuation_target_changed")
}

func TestContinuationPartialFailureAllowsOneDiagnosisWithoutResubmission(t *testing.T) {
	fx, row := continuationFixture(t, "image")
	manifest := continuationManifest(t, fx, row, false, "out-a", "out-b")
	continuationTask(t, fx, row, manifest.Submissions[0], "a", "succeeded", true)
	continuationTask(t, fx, row, manifest.Submissions[1], "b", "failed", false)
	claim, err := fx.turns.ClaimContinuation(fx.userID, row.ID, nil)
	if err != nil || len(claim.SelectedNodeIDs) != 2 {
		t.Fatalf("claim %+v %v", claim, err)
	}
	var count int64
	fx.db.Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatal("claim created tasks")
	}
}

func TestContinuationNativeMultiOutputUsesActualDeliveryPrimaryBindingAndIndexedTargets(t *testing.T) {
	fx, row := continuationFixture(t, "image")
	manifest := continuationManifest(t, fx, row, true, "out-a", "out-b", "out-c")
	continuationTask(t, fx, row, manifest.Submissions[0], "native", "succeeded", true)
	claim, err := fx.turns.ClaimContinuation(fx.userID, row.ID, nil)
	if err != nil || !reflect.DeepEqual(claim.SelectedNodeIDs, []string{"out-a", "out-b", "out-c"}) || !reflect.DeepEqual(claim.TaskIDs, []string{"native"}) {
		t.Fatalf("native result %+v %v", claim, err)
	}
}

func TestContinuationCancellationScopeAndOwnershipRemainDurable(t *testing.T) {
	for _, action := range []string{"stop-waiting", "stop-claimed", "new-message", "new-scope", "clear", "undo"} {
		t.Run(action, func(t *testing.T) {
			fx, row := continuationFixture(t, "image")
			if action == "stop-claimed" {
				manifest := continuationManifest(t, fx, row, true, "source")
				continuationTask(t, fx, row, manifest.Submissions[0], "task", "failed", false)
				if _, err := fx.turns.ClaimContinuation(fx.userID, row.ID, nil); err != nil {
					t.Fatal(err)
				}
			}
			var err error
			switch action {
			case "new-scope", "clear":
				ctx, _ := fx.turns.SkillContext(fx.userID, fx.canvasID, contextSession)
				a := "new_scope"
				if action == "clear" {
					a = "clear"
				}
				_, err = fx.turns.ChangeSkillContext(fx.userID, fx.canvasID, assistantturns.SkillContextChange{SessionID: contextSession, Action: a, RequestID: action, ExpectedRevision: ctx.Revision})
			case "undo":
				_, err = fx.turns.Undo(fx.userID, fx.canvasID, continuationSource)
			default:
				err = fx.turns.CancelContinuations(fx.userID, fx.canvasID, contextSession, action == "new-message")
			}
			if err != nil {
				t.Fatal(err)
			}
			var stored model.AssistantContinuation
			fx.db.First(&stored, "id = ?", row.ID)
			if stored.State != "cancelled" {
				t.Fatal("not cancelled", stored.State)
			}
			reopened := fx.reopen(t)
			if _, err := reopened.turns.ClaimContinuation(fx.userID, row.ID, nil); err == nil {
				t.Fatal("revived cancelled authorization")
			}
			if action == "stop-claimed" {
				if _, allowed, _ := fx.turns.ScopeForHost(fx.userID, row.TurnID); allowed {
					t.Fatal("cancelled turn allows writes")
				}
				state, err := fx.turns.RuntimeState(fx.userID, row.TurnID)
				if err != nil || state.Open || !state.ContinuationRevoked {
					t.Fatalf("cannot acknowledge cancelled turn %+v %v", state, err)
				}
				if err := fx.turns.Finalize(row.TurnID); err != nil {
					t.Fatal("cancelled completion acknowledgement", err)
				}
			}
		})
	}
	fx, row := continuationFixture(t, "video")
	if _, err := fx.turns.ClaimContinuation("foreign", row.ID, nil); err == nil {
		t.Fatal("foreign claim")
	}
	rows, err := fx.turns.ListContinuations(fx.userID, fx.canvasID, "another-session")
	if err != nil || len(rows) != 0 {
		t.Fatalf("cross session rows %+v %v", rows, err)
	}
}
