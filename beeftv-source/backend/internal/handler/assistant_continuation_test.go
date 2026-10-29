package handler

import (
	"encoding/json"
	"fmt"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
	"net/http"
	"testing"
)

func TestAssistantContinuationHTTPReusesTrustedTurnAndExcludesComposerInputs(t *testing.T) {
	var forwarded []map[string]any
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/chat" {
				w.Write([]byte(`{}`))
				return
			}
			var input map[string]any
			json.NewDecoder(r.Body).Decode(&input)
			forwarded = append(forwarded, input)
			if len(forwarded) == 1 {
				w.WriteHeader(http.StatusServiceUnavailable)
				w.Write([]byte(`{"reason":"temporary_database_error"}`))
				return
			}
			// Observer ends without turn_end: a retry must reuse the claimed Go turn.
			w.Header().Set("Content-Type", "application/x-ndjson")
			json.NewEncoder(w).Encode(map[string]any{"type": "session", "sessionId": input["sessionId"], "turnId": input["turnId"]})
		})
	})
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := env.service.UserCanvasProject(owner.ID, env.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	json.Unmarshal(raw, &doc)
	node := doc["nodes"].([]any)[0].(map[string]any)
	node["type"] = "image"
	node["metadata"] = map[string]any{"taskId": "failed-task", "taskStatus": "failed", "status": "error"}
	raw, _ = json.Marshal(doc)
	if _, err = env.service.UpsertUserCanvasProject(owner.ID, raw); err != nil {
		t.Fatal(err)
	}
	source, session := "aabbccddeeff", "durable:11111111-2222-3333-4444-555555555555"
	if _, err = env.service.BeginAssistantTurn(owner.ID, env.canvasID, source, app.AssistantTurnInput{PermissionMode: assistantturns.PermissionCanvas}); err != nil {
		t.Fatal(err)
	}
	if err = env.service.BindAssistantDurableSession(owner.ID, source, session, false); err != nil {
		t.Fatal(err)
	}
	if err = env.service.FinalizeAssistantTurn(source); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(assistantturns.ContinuationInput{CanvasID: env.canvasID, SessionID: session, SourceTurnID: source, ProposalID: "gp-fixture", Kind: "image", NodeIDs: []string{"n1"}})
	arm := env.call(t, http.MethodPost, "/assistant/continuations", string(body))
	if arm.Code != 200 {
		t.Fatal(arm.Code, arm.Body.String())
	}
	data := decodeEnvelope(t, arm)
	id := data["id"].(string)
	if ids, ok := data["taskIds"].([]any); !ok || len(ids) != 0 {
		t.Fatal("waiting task ids must be an empty array", data)
	}
	manifest := env.call(t, http.MethodPost, "/assistant/continuations/"+id+"/manifest", `{"sourceNodeId":"n1","submissions":[{"operationId":"proposal:gp-fixture:n1","outputNodeIds":["n1"]}]}`)
	if manifest.Code != 200 {
		t.Fatal(manifest.Code, manifest.Body.String())
	}
	operation := "proposal:gp-fixture:n1"
	if err = env.service.Database().Create(&model.Task{ID: "failed-task", UserID: owner.ID, ProjectID: env.canvasID, ClientOperationID: &operation, Type: "canvas_image", Status: model.TaskStatusFailed, InputJSON: `{"metadata":{"sourceNodeId":"n1","nodeId":"n1"}}`}).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		request, _ := json.Marshal(map[string]any{"canvasId": env.canvasID, "sessionId": session, "continuationId": id, "message": "do not send draft", "permissionMode": "full-access", "requestId": "client-request", "selectedNodeIds": []string{"foreign"}, "skills": []any{map[string]any{"skillId": "bad"}}, "references": []any{map[string]any{"kind": "asset", "id": "foreign"}}})
		response := env.call(t, http.MethodPost, "/assistant/chat", string(request))
		want := 200
		if i == 0 {
			want = http.StatusServiceUnavailable
		}
		if response.Code != want {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	if len(forwarded) != 2 {
		t.Fatal("host calls", len(forwarded))
	}
	for _, input := range forwarded {
		if input["continuationId"] != id || input["turnId"] != data["turnId"] || input["requestId"] != data["requestId"] || input["message"] != assistantturns.ContinuationMessage || input["permissionMode"] != "canvas" {
			t.Fatalf("untrusted continuation %+v", input)
		}
		ids := input["selectedNodeIds"].([]any)
		if len(ids) != 1 || ids[0] != "n1" {
			t.Fatal("wrong actual results", input)
		}
		for _, key := range []string{"skills", "attachments", "references"} {
			if values, ok := input[key].([]any); ok && len(values) > 0 {
				t.Fatal("composer leaked", key, input)
			}
		}
	}
	var count int64
	env.service.Database().Model(&model.AssistantTurn{}).Count(&count)
	if count != 2 {
		t.Fatal("duplicate business turn", count)
	}
	invalid := env.call(t, http.MethodPost, "/assistant/cancel", `{"canvasId":"`+env.canvasID+`","sessionId":"`+session+`","requestId":"bad request"}`)
	if invalid.Code != 400 {
		t.Fatal(invalid.Code)
	}
	var row model.AssistantContinuation
	env.service.Database().First(&row, "id = ?", id)
	if row.State != "claimed" {
		t.Fatal("invalid stop mutated authority", row.State)
	}
	stopped := env.call(t, http.MethodPost, "/assistant/continuations/cancel", `{"canvasId":"`+env.canvasID+`","sessionId":"`+session+`"}`)
	if stopped.Code != 200 {
		t.Fatal(stopped.Code)
	}
	headers := map[string]string{"X-Beeftv-Agent-Token": assistantTestHostToken}
	completed := env.callWithHeaders(t, http.MethodPost, "/assistant/runtime/turns/"+row.TurnID+"/complete", "{}", headers)
	state := decodeEnvelope(t, completed)
	if completed.Code != 200 || state["open"] != false || state["continuationRevoked"] != true {
		t.Fatalf("cancelled host ack %d %s", completed.Code, completed.Body.String())
	}
	rejected := env.call(t, http.MethodPost, "/assistant/continuations/"+id+"/claim", `{}`)
	if rejected.Code == 200 {
		t.Fatal("cancelled claim revived")
	}
}

func TestAssistantContinuationDisplayIdentityCannotBeSuppliedByManualTextOrJSON(t *testing.T) {
	var forwarded []map[string]any
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/chat" {
				w.Write([]byte(`{}`))
				return
			}
			var input map[string]any
			json.NewDecoder(r.Body).Decode(&input)
			forwarded = append(forwarded, input)
			w.Header().Set("Content-Type", "application/x-ndjson")
			json.NewEncoder(w).Encode(map[string]any{"type": "session", "sessionId": input["sessionId"], "turnId": input["turnId"]})
		})
	})
	message, _ := json.Marshal(assistantturns.ContinuationMessage)
	for _, fields := range []string{"", `,"continuationId":"spoofed","ContinuationID":""`} {
		body := fmt.Sprintf(`{"canvasId":%q,"sessionId":"manual","message":%s,"permissionMode":"canvas"%s}`, env.canvasID, message, fields)
		response := env.call(t, http.MethodPost, "/assistant/chat", body)
		if response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
		input := forwarded[len(forwarded)-1]
		if input["continuationId"] != nil || input["message"] != assistantturns.ContinuationMessage {
			t.Fatalf("manual message acquired automatic display identity: %+v", input)
		}
	}
	invalid := fmt.Sprintf(`{"canvasId":%q,"sessionId":"manual","message":%s,"permissionMode":"canvas","continuationId":"not-a-receipt"}`, env.canvasID, message)
	response := env.call(t, http.MethodPost, "/assistant/chat", invalid)
	if response.Code == 200 || len(forwarded) != 2 {
		t.Fatal("unverified continuation reached host", response.Code, len(forwarded))
	}
}

func TestAssistantContinuationSkillLoadKeepsItsBoundTurnAuthorized(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := env.service.UserCanvasProject(owner.ID, env.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	json.Unmarshal(raw, &doc)
	node := doc["nodes"].([]any)[0].(map[string]any)
	node["type"] = "image"
	node["metadata"] = map[string]any{"taskId": "skill-load-task", "taskStatus": "failed", "status": "error"}
	doc["nodes"] = append(doc["nodes"].([]any), map[string]any{"id": "n2", "type": "image", "position": map[string]any{"x": 10, "y": 10}, "metadata": map[string]any{"taskId": "companion-task", "taskStatus": "failed", "status": "error"}})
	raw, _ = json.Marshal(doc)
	if _, err = env.service.UpsertUserCanvasProject(owner.ID, raw); err != nil {
		t.Fatal(err)
	}
	source := "aabbccddffee"
	env.beginTurn(t, source, app.AssistantTurnInput{})
	if err = env.service.BindAssistantDurableSession(owner.ID, source, skillSessionOne, false); err != nil {
		t.Fatal(err)
	}
	if err = env.service.FinalizeAssistantTurn(source); err != nil {
		t.Fatal(err)
	}
	row, err := env.service.ArmAssistantContinuation(owner.ID, assistantturns.ContinuationInput{CanvasID: env.canvasID, SessionID: skillSessionOne, SourceTurnID: source, ProposalID: "gp-load", Kind: "image", NodeIDs: []string{"n1"}})
	if err != nil {
		t.Fatal(err)
	}
	operation := "proposal:gp-load:n1"
	if err = env.service.RegisterAssistantContinuationManifest(owner.ID, row.ID, assistantturns.ContinuationManifest{SourceNodeID: "n1", Submissions: []assistantturns.ContinuationSubmission{{OperationID: operation, OutputNodeIDs: []string{"n1"}}}}); err != nil {
		t.Fatal(err)
	}
	if err = env.service.Database().Create(&model.Task{ID: "skill-load-task", UserID: owner.ID, ProjectID: env.canvasID, ClientOperationID: &operation, Type: "canvas_image", Status: model.TaskStatusFailed, InputJSON: `{"metadata":{"sourceNodeId":"n1","nodeId":"n1"}}`}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = env.service.ClaimAssistantContinuation(owner.ID, row.ID); err != nil {
		t.Fatal(err)
	}
	if err = env.service.VerifyAssistantContinuation(owner.ID, row.ID, row.TurnID, skillSessionOne); err != nil {
		t.Fatal(err)
	}
	companion, err := env.service.ArmAssistantContinuation(owner.ID, assistantturns.ContinuationInput{CanvasID: env.canvasID, SessionID: skillSessionOne, SourceTurnID: source, ProposalID: "gp-companion", Kind: "image", NodeIDs: []string{"n2"}})
	if err != nil {
		t.Fatal(err)
	}
	companionOperation := "proposal:gp-companion:n2"
	if err = env.service.RegisterAssistantContinuationManifest(owner.ID, companion.ID, assistantturns.ContinuationManifest{SourceNodeID: "n2", Submissions: []assistantturns.ContinuationSubmission{{OperationID: companionOperation, OutputNodeIDs: []string{"n2"}}}}); err != nil {
		t.Fatal(err)
	}
	if err = env.service.Database().Create(&model.Task{ID: "companion-task", UserID: owner.ID, ProjectID: env.canvasID, ClientOperationID: &companionOperation, Type: "canvas_image", Status: model.TaskStatusFailed, InputJSON: `{"metadata":{"sourceNodeId":"n2","nodeId":"n2"}}`}).Error; err != nil {
		t.Fatal(err)
	}
	cancelled, err := env.service.ArmAssistantContinuation(owner.ID, assistantturns.ContinuationInput{CanvasID: env.canvasID, SessionID: skillSessionOne, SourceTurnID: source, ProposalID: "gp-cancelled", Kind: "image", NodeIDs: []string{"n2"}})
	if err != nil {
		t.Fatal(err)
	}
	if err = env.service.Database().Model(&model.AssistantContinuation{}).Where("id = ?", cancelled.ID).Update("state", "cancelled").Error; err != nil {
		t.Fatal(err)
	}
	pin := installTestSkill(t, env, owner.ID, map[string]string{"SKILL.md": "---\nname: Continue\ndescription: edit\n---\nInspect then edit."})
	path := "/assistant/runtime/canvases/" + env.canvasID + "/skill-context"
	headers := map[string]string{"X-Beeftv-Agent-Token": assistantTestHostToken}
	for _, body := range []string{
		`{"sessionId":"` + skillSessionOne + `","origin":"skill_load","action":"activate","requestId":"spoof","expectedRevision":0}`,
		`{"sessionId":"` + skillSessionOne + `","origin":"skill_load","turnId":"` + row.TurnID + `","action":"new_scope","requestId":"spoof","expectedRevision":0}`,
	} {
		if response := env.callWithHeaders(t, http.MethodPost, path, body, headers); response.Code != 400 {
			t.Fatal("invalid load identity accepted", response.Code)
		}
	}
	for index := 0; index < 2; index++ {
		ctx, err := env.service.AssistantSkillContext(owner.ID, env.canvasID, skillSessionOne)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := json.Marshal(map[string]any{"sessionId": skillSessionOne, "turnId": row.TurnID, "origin": "skill_load", "action": "activate", "requestId": fmt.Sprintf("select:tool:%d", index), "expectedRevision": ctx.Revision, "pins": []any{pin}})
		if response := env.call(t, http.MethodPost, path, string(body)); response.Code != http.StatusForbidden {
			t.Fatal("UI spoofed host skill_load", response.Code)
		}
		response := env.callWithHeaders(t, http.MethodPost, path, string(body), headers)
		if response.Code != 200 {
			t.Fatalf("skill_load %d %s", response.Code, response.Body.String())
		}
		// Replay must not advance the scope or revoke the turn, either.
		replay := env.callWithHeaders(t, http.MethodPost, path, string(body), headers)
		if replay.Code != 200 {
			t.Fatal(replay.Code, replay.Body.String())
		}
		if _, err = env.service.BoundAssistantSkillContext(owner.ID, row.TurnID, skillSessionOne); err != nil {
			t.Fatal("skill_load closed its own turn", err)
		}
		if _, allowed, scopeErr := env.service.AssistantTurnScopeForHost(owner.ID, row.TurnID); scopeErr != nil || !allowed {
			t.Fatal("skill_load revoked operation authorization", scopeErr)
		}
		var stored model.AssistantContinuation
		env.service.Database().First(&stored, "id = ?", row.ID)
		if stored.State != "running" || stored.ScopeRevision != ctx.Revision+1 {
			t.Fatalf("lost continuation %+v", stored)
		}
		var waiting, revoked model.AssistantContinuation
		env.service.Database().First(&waiting, "id = ?", companion.ID)
		wantState := "waiting"
		if index > 0 {
			wantState = "claimed"
		}
		if waiting.State != wantState || waiting.ScopeRevision != ctx.Revision+1 {
			t.Fatalf("skill load stranded the other confirmed proposal: %+v", waiting)
		}
		env.service.Database().First(&revoked, "id = ?", cancelled.ID)
		if revoked.State != "cancelled" || revoked.ScopeRevision != cancelled.ScopeRevision {
			t.Fatalf("skill load revived cancelled authority: %+v", revoked)
		}
		if index == 0 {
			if _, err = env.service.ClaimAssistantContinuation(owner.ID, companion.ID); err != nil {
				t.Fatal("other proposal cannot claim after runtime load", err)
			}
		}
	}
	if _, err = env.service.ClaimAssistantContinuation(owner.ID, companion.ID); err != nil {
		t.Fatal("other confirmed result cannot continue after skill load", err)
	}
	if _, err = env.service.ClaimAssistantContinuation(owner.ID, cancelled.ID); err == nil {
		t.Fatal("cancelled result revived")
	}
	ctx, _ := env.service.AssistantSkillContext(owner.ID, env.canvasID, skillSessionOne)
	// An explicit user/session selection is not a runtime skill load.
	body, _ := json.Marshal(map[string]any{"sessionId": skillSessionOne, "action": "activate", "requestId": "user-selection", "expectedRevision": ctx.Revision, "pins": []any{pin}})
	response := env.callWithHeaders(t, http.MethodPost, path, string(body), headers)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	if _, err = env.service.BoundAssistantSkillContext(owner.ID, row.TurnID, skillSessionOne); err == nil {
		t.Fatal("user selection did not revoke automatic turn")
	}
	if _, err = env.service.ClaimAssistantContinuation(owner.ID, companion.ID); err == nil {
		t.Fatal("user selection did not revoke companion authority")
	}
	// A new normal user turn's own explicit initial selection is valid new intent.
	fresh := "aabbccddffaa"
	env.beginTurn(t, fresh, app.AssistantTurnInput{})
	if err = env.service.BindAssistantDurableSession(owner.ID, fresh, skillSessionOne, false); err != nil {
		t.Fatal(err)
	}
	ctx, _ = env.service.AssistantSkillContext(owner.ID, env.canvasID, skillSessionOne)
	body, _ = json.Marshal(map[string]any{"sessionId": skillSessionOne, "turnId": fresh, "action": "activate", "requestId": "select:new-user", "expectedRevision": ctx.Revision, "pins": []any{pin}})
	response = env.callWithHeaders(t, http.MethodPost, path, string(body), headers)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	if err = env.service.FinalizeAssistantTurn(fresh); err != nil {
		t.Fatal(err)
	}
	if _, err = env.service.ArmAssistantContinuation(owner.ID, assistantturns.ContinuationInput{CanvasID: env.canvasID, SessionID: skillSessionOne, SourceTurnID: fresh, ProposalID: "gp-fresh", Kind: "image", NodeIDs: []string{"n1"}}); err != nil {
		t.Fatal("initial user selection invalidated its new proposals", err)
	}
}
