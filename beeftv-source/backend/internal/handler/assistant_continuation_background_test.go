package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
)

func claimBackgroundHTTPContinuation(t *testing.T, env *assistantTestEnv) *assistantturns.ContinuationView {
	t.Helper()
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := env.service.UserCanvasProject(owner.ID, env.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	node := doc["nodes"].([]any)[0].(map[string]any)
	node["type"] = "image"
	node["metadata"] = map[string]any{"taskId": "background-task", "taskStatus": "failed", "status": "error"}
	raw, _ = json.Marshal(doc)
	if _, err = env.service.UpsertUserCanvasProject(owner.ID, raw); err != nil {
		t.Fatal(err)
	}
	const source = "aabbccddeeff"
	const session = "durable:11111111-2222-3333-4444-555555555555"
	if _, err = env.service.BeginAssistantTurn(owner.ID, env.canvasID, source, app.AssistantTurnInput{PermissionMode: assistantturns.PermissionCanvas}); err != nil {
		t.Fatal(err)
	}
	if err = env.service.BindAssistantDurableSession(owner.ID, source, session, false); err != nil {
		t.Fatal(err)
	}
	if err = env.service.FinalizeAssistantTurn(source); err != nil {
		t.Fatal(err)
	}
	row, err := env.service.ArmAssistantContinuation(owner.ID, assistantturns.ContinuationInput{
		CanvasID: env.canvasID, SessionID: session, SourceTurnID: source,
		ProposalID: "gp-background", Kind: "image", NodeIDs: []string{"n1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	opID := "proposal:gp-background:n1"
	if err = env.service.RegisterAssistantContinuationManifest(owner.ID, row.ID, assistantturns.ContinuationManifest{
		SourceNodeID: "n1", Submissions: []assistantturns.ContinuationSubmission{{OperationID: opID, OutputNodeIDs: []string{"n1"}}},
	}); err != nil {
		t.Fatal(err)
	}
	if err = env.service.Database().Create(&model.Task{ID: "background-task", UserID: owner.ID, ProjectID: env.canvasID,
		ClientOperationID: &opID, Type: "canvas_image", Status: model.TaskStatusFailed,
		InputJSON: `{"metadata":{"sourceNodeId":"n1","nodeId":"n1","outputNodeIds":["n1"]}}`,
	}).Error; err != nil {
		t.Fatal(err)
	}
	claimed, err := env.service.ClaimAssistantContinuation(owner.ID, row.ID)
	if err != nil {
		t.Fatal(err)
	}
	return claimed
}

func TestAssistantBackgroundContinuationHTTPUnknownAdmissionDoesNotFinalize(t *testing.T) {
	for _, scenario := range []string{"503", "EOF", "observer_error", "unrelated_terminal"} {
		t.Run(scenario, func(t *testing.T) {
			received := make(chan map[string]any, 1)
			env := newAssistantTestEnv(t, func(_ *assistantTestEnv) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path != "/chat" {
						http.NotFound(w, r)
						return
					}
					if r.Header.Get("X-Beeftv-Agent-Token") != assistantTestHostToken {
						w.WriteHeader(http.StatusForbidden)
						return
					}
					var input map[string]any
					_ = json.NewDecoder(r.Body).Decode(&input)
					received <- input
					if scenario == "503" {
						w.WriteHeader(http.StatusServiceUnavailable)
						_, _ = io.WriteString(w, `{"reason":"temporary_database_error"}`)
						return
					}
					w.Header().Set("Content-Type", "application/x-ndjson")
					switch scenario {
					case "EOF":
						_ = json.NewEncoder(w).Encode(map[string]any{"type": "session", "sessionId": input["sessionId"]})
					case "observer_error":
						_, _ = io.WriteString(w, "{\"type\":\"observer_error\",\"reason\":\"interrupted\"}\n")
					case "unrelated_terminal":
						_, _ = io.WriteString(w, "{\"type\":\"turn_end\",\"turnId\":\"other\"}\n")
					}
				})
			})
			row := claimBackgroundHTTPContinuation(t, env)
			if err := AssistantContinuationSubmitter(env.service, env.assistantHost)(t.Context(), *row); err == nil {
				t.Fatal("uncertain observer response was reported as completed")
			}
			input := <-received
			if input["turnId"] != row.TurnID || input["requestId"] != row.RequestID || input["continuationId"] != row.ID || input["sessionId"] != row.SessionID || input["permissionMode"] != "canvas" || input["message"] != assistantturns.ContinuationMessage {
				t.Fatalf("wrong trusted envelope: %+v", input)
			}
			for _, field := range []string{"references", "attachments", "skills"} {
				if _, exists := input[field]; exists {
					t.Fatal("background request included composer input", field)
				}
			}
			state, err := env.service.AssistantTurnRuntimeState(row.UserID, row.TurnID)
			if err != nil || !state.Open {
				t.Fatalf("unknown admission settled the Go turn: %+v %v", state, err)
			}
		})
	}
}

func TestAssistantBackgroundContinuationHTTPRetryPreservesCommittedOperation(t *testing.T) {
	var calls atomic.Int32
	var params atomic.Value
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var input map[string]any
			_ = json.NewDecoder(r.Body).Decode(&input)
			turnID, _ := input["turnId"].(string)
			if code, _ := env.opsRaw("canvas.node.update", "background-inspection-result", turnID, params.Load().(string)); code != http.StatusOK {
				w.WriteHeader(code)
				return
			}
			w.Header().Set("Content-Type", "application/x-ndjson")
			if calls.Add(1) == 1 {
				// The operation committed but the observer lost the terminal.
				_ = json.NewEncoder(w).Encode(map[string]any{"type": "session", "sessionId": input["sessionId"]})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "turn_end", "turnId": turnID})
		})
	})
	row := claimBackgroundHTTPContinuation(t, env)
	params.Store(fmt.Sprintf(`{"canvasId":%q,"nodeId":"n1","expectedRevision":%d,"patch":{"title":"检查完成"}}`, row.CanvasID, row.RevisionBefore))
	submit := AssistantContinuationSubmitter(env.service, env.assistantHost)
	if err := submit(t.Context(), *row); err == nil {
		t.Fatal("lost terminal must remain recoverable")
	}
	retry, err := env.service.ClaimAssistantContinuation(row.UserID, row.ID)
	if err != nil || retry.RequestID != row.RequestID || retry.TurnID != row.TurnID {
		t.Fatalf("unstable retry: %+v %v", retry, err)
	}
	if err = submit(t.Context(), *retry); err != nil {
		t.Fatal(err)
	}
	var receipts int64
	if err = env.service.Database().Model(&model.AgentOpRecord{}).Where("turn_id = ?", row.TurnID).Count(&receipts).Error; err != nil || receipts != 1 {
		t.Fatalf("operation replayed: %d %v", receipts, err)
	}
	raw, err := env.service.UserCanvasProject(row.UserID, row.CanvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	if int64(doc["revision"].(float64)) != row.RevisionBefore+1 {
		t.Fatal("retry wrote a second canvas revision", doc["revision"])
	}
	var stored model.AssistantContinuation
	if err = env.service.Database().First(&stored, "id = ?", row.ID).Error; err != nil || stored.State != "done" {
		t.Fatalf("terminal did not settle receipt: %+v %v", stored, err)
	}
}

func TestAssistantBackgroundContinuationHTTPObserverStopsWithoutSettlingOnExit(t *testing.T) {
	started, exited := make(chan struct{}), make(chan struct{})
	env := newAssistantTestEnv(t, func(_ *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", "application/x-ndjson")
			_, _ = io.WriteString(w, "{\"type\":\"session\"}\n")
			w.(http.Flusher).Flush()
			close(started)
			<-r.Context().Done()
			close(exited)
		})
	})
	row := claimBackgroundHTTPContinuation(t, env)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- AssistantContinuationSubmitter(env.service, env.assistantHost)(ctx, *row) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("observer did not attach")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled HTTP stream reported terminal success")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("observer ignored runtime cancellation")
	}
	select {
	case <-exited:
	case <-time.After(3 * time.Second):
		t.Fatal("owned host HTTP request survived runtime exit")
	}
	state, err := env.service.AssistantTurnRuntimeState(row.UserID, row.TurnID)
	if err != nil || !state.Open {
		t.Fatalf("exit discarded recoverable turn: %+v %v", state, err)
	}
}
