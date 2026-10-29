package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/skills"
)

func TestAssistantProposalRunRejectedAfterUndo(t *testing.T) {
	var turnID string
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/chat" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			var body struct {
				TurnID         string `json:"turnId"`
				RevisionBefore int64  `json:"revisionBefore"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			turnID = body.TurnID
			params, _ := json.Marshal(map[string]any{"canvasId": env.canvasID, "nodeId": "n1", "expectedRevision": body.RevisionBefore, "patch": map[string]any{"title": "改过的标题"}})
			if status, result := env.opsRaw("canvas.node.update", "proposal-gate-operation", turnID, string(params)); status != http.StatusOK {
				t.Errorf("write failed: %d %s", status, result)
			}
			w.Header().Set("Content-Type", "application/x-ndjson")
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "turn_end", "turnId": turnID, "reply": "好", "toolCalls": []any{},
				"proposals": []any{map[string]any{"proposalId": "gp-0011223344556677", "kind": "image", "nodeIds": []string{"n1"}}}})
		})
	})
	useEnvProvider(t, "chat-completion")
	if response := env.call(t, http.MethodPost, "/assistant/chat", `{"canvasId":"`+env.canvasID+`","message":"改标题"}`); response.Code != http.StatusOK || turnID == "" {
		t.Fatalf("chat failed: %d %s", response.Code, response.Body.String())
	}
	run := func(turn, proposal, canvasID string) *httptest.ResponseRecorder {
		return env.call(t, http.MethodPost, "/assistant/turns/"+turn+"/proposals/"+proposal+"/run", `{"canvasId":"`+canvasID+`"}`)
	}
	if response := run(turnID, "gp-0011223344556677", env.canvasID); response.Code != http.StatusOK {
		t.Fatalf("a live round may start its generation: %d %s", response.Code, response.Body.String())
	}
	if response := run("00112233445566", "gp-0011223344556677", env.canvasID); response.Code != http.StatusNotFound {
		t.Fatalf("unknown round should be 404: %d %s", response.Code, response.Body.String())
	}
	if response := run(turnID, "bad%20id", env.canvasID); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid proposal id should be 400: %d %s", response.Code, response.Body.String())
	}
	if response := env.call(t, http.MethodPost, "/assistant/turns/"+turnID+"/undo", `{"canvasId":"`+env.canvasID+`"}`); response.Code != http.StatusOK {
		t.Fatalf("undo failed: %d %s", response.Code, response.Body.String())
	}
	response := run(turnID, "gp-0011223344556677", env.canvasID)
	if response.Code != http.StatusConflict {
		t.Fatalf("an undone round must be rejected with 409: %d %s", response.Code, response.Body.String())
	}
	var envelope struct {
		Code   int    `json:"code"`
		Reason string `json:"reason"`
		Msg    string `json:"msg"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || envelope.Code != http.StatusConflict || envelope.Reason != app.AssistantTurnReasonUndone || envelope.Msg == "" {
		t.Fatalf("envelope must carry code and machine reason: %s", response.Body.String())
	}
}

func TestAssistantHistoryLabelsSkillsFromStoredPins(t *testing.T) {
	turnID := "0123456789abcdef"
	hash := strings.Repeat("c", 64)
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/history" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"sessionId": "s1", "turns": []any{map[string]any{
				"turnId": turnID, "userText": "拆资产",
				"skills": []any{
					map[string]any{"skillId": "batch", "versionId": "v1", "contentHash": hash},
					map[string]any{"skillId": "gone", "versionId": "v9", "contentHash": hash, "skillName": "宿主自报"},
				},
				"supplementInputs": []any{map[string]any{"message": "再补一句", "skills": []any{map[string]any{"skillId": "batch", "versionId": "v1", "contentHash": hash}}}},
			}}})
		})
	})
	owner, _ := env.service.LocalWorkspaceOwner()
	pin := skills.Pin{SkillID: "batch", VersionID: "v1", ContentHash: hash, SkillName: "短剧资产分批流程", Version: "1"}
	if _, err := env.service.BeginAssistantTurn(owner.ID, env.canvasID, turnID, app.AssistantTurnInput{SkillPins: []skills.Pin{pin}}); err != nil {
		t.Fatal(err)
	}
	history := decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/history?canvasId="+env.canvasID, ""))
	turn := history["turns"].([]any)[0].(map[string]any)
	list := turn["skills"].([]any)
	labeled := list[0].(map[string]any)
	if labeled["skillName"] != "短剧资产分批流程" || labeled["version"] != "1" {
		t.Fatalf("stored pin labels must reach the UI: %#v", labeled)
	}
	if unknown := list[1].(map[string]any); unknown["skillName"] != nil || unknown["version"] != nil {
		t.Fatalf("a skill without a stored label must not carry host-provided labels: %#v", unknown)
	}
	supplement := turn["supplementInputs"].([]any)[0].(map[string]any)["skills"].([]any)[0].(map[string]any)
	if supplement["skillName"] != "短剧资产分批流程" {
		t.Fatalf("supplement skills must be labeled too: %#v", supplement)
	}
}
