package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
)

func TestAssistantNewIntentStopsRunningContinuationBeforeAdmission(t *testing.T) {
	for _, action := range []string{"chat", "sessions", "activate"} {
		for _, firstFailure := range []string{"none", "503", "malformed", "unconfirmed", "connection_lost"} {
			t.Run(action+"/"+firstFailure, func(t *testing.T) {
				var original atomic.Pointer[assistantturns.ContinuationView]
				var busy atomic.Bool
				busy.Store(true)
				var cancels, admitted atomic.Int32
				targets := make(chan map[string]string, 4)
				messages := make(chan map[string]any, 2)
				env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
					return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.URL.Path == "/cancel" {
							var target map[string]string
							_ = json.NewDecoder(r.Body).Decode(&target)
							targets <- target
							row := original.Load()
							if row == nil || len(target) != 3 || target["canvasId"] != row.CanvasID || target["sessionId"] != row.SessionID || target["requestId"] != row.RequestID {
								w.WriteHeader(http.StatusBadRequest)
								return
							}
							// The actual host completes the Go turn BEFORE awaiting
							// official Durable stop and returning its cancellation result.
							completed := env.callWithHeaders(t, http.MethodPost, "/assistant/runtime/turns/"+row.TurnID+"/complete", `{}`, map[string]string{"X-Beeftv-Agent-Token": assistantTestHostToken})
							if completed.Code != http.StatusOK {
								w.WriteHeader(http.StatusInternalServerError)
								return
							}
							if cancels.Add(1) == 1 && firstFailure != "none" {
								switch firstFailure {
								case "503":
									w.WriteHeader(http.StatusServiceUnavailable)
									_, _ = w.Write([]byte(`{"reason":"temporary_database_error"}`))
								case "malformed":
									_, _ = w.Write([]byte(`not-json`))
								case "unconfirmed":
									_, _ = w.Write([]byte(`{"accepted":true,"state":"running"}`))
								case "connection_lost":
									connection, _, err := w.(http.Hijacker).Hijack()
									if err == nil {
										_ = connection.Close()
									}
								}
								return
							}
							busy.Store(false)
							w.WriteHeader(http.StatusAccepted)
							_, _ = w.Write([]byte(`{"accepted":true,"state":"stopped"}`))
							return
						}
						if busy.Load() {
							w.WriteHeader(http.StatusConflict)
							_, _ = w.Write([]byte(`{"reason":"session_busy"}`))
							return
						}
						var body map[string]any
						_ = json.NewDecoder(r.Body).Decode(&body)
						messages <- body
						admitted.Add(1)
						if r.URL.Path == "/chat" {
							w.Header().Set("Content-Type", "application/x-ndjson")
							_ = json.NewEncoder(w).Encode(map[string]any{"type": "turn_end", "turnId": body["turnId"]})
						} else {
							_ = json.NewEncoder(w).Encode(map[string]any{"sessionId": body["sessionId"]})
						}
					})
				})
				row := claimBackgroundHTTPContinuation(t, env)
				if err := env.service.VerifyAssistantContinuation(row.UserID, row.ID, row.TurnID, row.SessionID); err != nil {
					t.Fatal(err)
				}
				original.Store(row)
				foreign := row.AssistantContinuation
				foreign.ID, foreign.TurnID, foreign.CanvasID, foreign.State = "other-canvas-receipt", "0011aabb", "other-canvas", "running"
				if err := env.service.Database().Create(&foreign).Error; err != nil {
					t.Fatal(err)
				}
				path, input := "/assistant/chat", fmt.Sprintf(`{"canvasId":%q,"sessionId":%q,"requestId":"new-user-request","message":"请改成新的结尾","permissionMode":"canvas"}`, row.CanvasID, row.SessionID)
				switch action {
				case "sessions":
					path, input = "/assistant/sessions", fmt.Sprintf(`{"canvasId":%q}`, row.CanvasID)
				case "activate":
					// Activating another session must stop the currently running
					// session of this canvas, not the target session or another canvas.
					path, input = "/assistant/sessions/activate", fmt.Sprintf(`{"canvasId":%q,"sessionId":"durable:99999999-2222-3333-4444-555555555555"}`, row.CanvasID)
				}
				if firstFailure != "none" {
					failed := env.call(t, http.MethodPost, path, input)
					if failed.Code != http.StatusServiceUnavailable || admitted.Load() != 0 {
						t.Fatalf("unknown cancel admitted new input: %d %s", failed.Code, failed.Body.String())
					}
					if action == "chat" && failed.Header().Get("X-Beeftv-Turn-Admission") != "rejected" {
						t.Fatal("new message must remain retryable before turn admission")
					}
					var stored model.AssistantContinuation
					if err := env.service.Database().First(&stored, "id = ?", row.ID).Error; err != nil || stored.State != "stopping" {
						t.Fatalf("lost retryable host target: %+v %v", stored, err)
					}
					state, err := env.service.AssistantTurnRuntimeState(row.UserID, row.TurnID)
					if err != nil || state.Open || !state.ContinuationRevoked {
						t.Fatalf("stopping continuation retained write authority: %+v %v", state, err)
					}
					listed, err := env.service.ListAssistantContinuations(row.UserID, row.CanvasID, row.SessionID)
					if err != nil || len(listed) != 0 {
						t.Fatalf("stopping receipt was offered to the page again: %+v %v", listed, err)
					}
					if _, err := env.service.ClaimAssistantContinuation(row.UserID, row.ID); err == nil {
						t.Fatal("a stale page could claim the stopping receipt")
					}
					var turns int64
					if err := env.service.Database().Model(&model.AssistantTurn{}).Count(&turns).Error; err != nil || turns != 2 {
						t.Fatalf("failed stop created a new business turn: %d %v", turns, err)
					}
				}
				response := env.call(t, http.MethodPost, path, input)
				if response.Code != http.StatusOK || admitted.Load() != 1 {
					t.Fatalf("new intent did not replace background request: %d %s", response.Code, response.Body.String())
				}
				wantCancels := int32(1)
				if firstFailure != "none" {
					wantCancels++
				}
				if cancels.Load() != wantCancels {
					t.Fatal("retry did not stop the same original request", cancels.Load())
				}
				for len(targets) > 0 {
					target := <-targets
					if target["requestId"] != row.RequestID || target["sessionId"] != row.SessionID || target["canvasId"] != row.CanvasID {
						t.Fatalf("stopped another request: %+v", target)
					}
				}
				message := <-messages
				if action == "chat" && (message["message"] != "请改成新的结尾" || message["requestId"] != "new-user-request" || message["turnId"] == row.TurnID) {
					t.Fatalf("lost or replaced user input: %+v", message)
				}
				var stored model.AssistantContinuation
				if err := env.service.Database().First(&stored, "id = ?", row.ID).Error; err != nil || stored.State != "cancelled" {
					t.Fatalf("old receipt remained runnable: %+v %v", stored, err)
				}
				if err := env.service.Database().First(&foreign, "id = ?", foreign.ID).Error; err != nil || foreign.State != "running" {
					t.Fatal("new intent affected another canvas", err)
				}
			})
		}
	}
}

func TestAssistantSteerPreservesRunningContinuation(t *testing.T) {
	var cancels, steers atomic.Int32
	env := newAssistantTestEnv(t, func(_ *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/cancel" {
				cancels.Add(1)
			}
			if r.URL.Path == "/steer" {
				steers.Add(1)
			}
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"accepted":true}`))
		})
	})
	row := claimBackgroundHTTPContinuation(t, env)
	if err := env.service.VerifyAssistantContinuation(row.UserID, row.ID, row.TurnID, row.SessionID); err != nil {
		t.Fatal(err)
	}
	response := env.call(t, http.MethodPost, "/assistant/steer", fmt.Sprintf(`{"canvasId":%q,"sessionId":%q,"message":"字幕移到上方"}`, row.CanvasID, row.SessionID))
	if response.Code != http.StatusOK || cancels.Load() != 0 || steers.Load() != 1 {
		t.Fatalf("steer changed into cancellation: %d %s", response.Code, response.Body.String())
	}
	var stored model.AssistantContinuation
	if err := env.service.Database().First(&stored, "id = ?", row.ID).Error; err != nil || stored.State != "running" {
		t.Fatalf("steer invalidated the current continuation: %+v %v", stored, err)
	}
}
