package app

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

// The shared fixture is also consumed by the frontend classifier test, so the
// exact task-list payload emitted after DB reload remains a cross-layer contract.
func TestReferenceAudioFailurePersistsThroughTaskOutput(t *testing.T) {
	data, err := os.ReadFile("../../../fixtures/reference-audio-errors.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Message, Display string }
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for i, tc := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			svc, db := newTimelineTaskTestService(t)
			task := seedRunningTimelineTask(t, db, `{}`)
			const requestID = "req_reference_audio_123"
			body, err := json.Marshal(map[string]any{"error": map[string]any{"code": "invalid_reference_audio", "message": tc.Message}})
			if err != nil {
				t.Fatal(err)
			}
			upstreamErr := providerHTTPError{StatusCode: 400, Body: string(body) + " (request id: " + requestID + ")"}
			// Exercise the same terminal coordinator and SQLite write used by a
			// failed provider request, rather than manually persisting a test string.
			_ = svc.terminalCoordinator().handleExecutionFailure(task, upstreamErr, false, false)
			var stored model.Task
			if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
				t.Fatal(err)
			}
			want := tc.Display + "。排查编号：请求 " + requestID + "。"
			if stored.Status != model.TaskStatusFailed || stored.Error != want {
				t.Fatalf("stored failure = %#v, want %s", stored, want)
			}
			output := taskSummaryForOutput(stored)
			if output.Error != want || output.ErrorCode != "invalid_params" {
				t.Fatalf("task output lost error details: %#v", output)
			}
			failure := generation.ClassifyText(output.Error)
			if failure.RequestID != requestID || !failure.BlocksAutomaticRetry() || !persistedFailureBlocksRetry(stored.Error, stored.Stage) {
				t.Fatalf("unsafe reloaded failure: %#v", failure)
			}
		})
	}
}
