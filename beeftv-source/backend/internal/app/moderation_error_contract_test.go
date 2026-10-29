package app

import (
	"encoding/json"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"os"
	"testing"
)

func TestModerationFailurePersistsThroughTaskOutput(t *testing.T) {
	data, err := os.ReadFile("../../../fixtures/moderation-errors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct{ Code, Message, Category, Reason, Action string }
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Code, func(t *testing.T) {
			svc, db := newTimelineTaskTestService(t)
			task := seedRunningTimelineTask(t, db, `{}`)
			raw, _ := json.Marshal(map[string]any{"error": map[string]string{"code": fixture.Code, "message": fixture.Message + " Request id: req_moderation_123"}})
			upstreamErr := newProviderPayloadError(string(raw))
			_ = svc.terminalCoordinator().handleExecutionFailure(task, upstreamErr, false, false)
			var stored model.Task
			if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
				t.Fatal(err)
			}
			want := fixture.Reason + "。" + fixture.Action + "。排查编号：请求 req_moderation_123。"
			if stored.Status != model.TaskStatusFailed || stored.Error != want {
				t.Fatalf("stored=%+v, want %s", stored, want)
			}
			summary := taskSummaryForOutput(stored)
			detail := taskForOutput(stored)
			if summary.Error != want || summary.ErrorCode != fixture.Category || detail.Error != want {
				t.Fatalf("summary=%+v detail=%+v", summary, detail)
			}
			if !generation.ClassifyText(summary.Error).BlocksAutomaticRetry() || !persistedFailureBlocksRetry(stored.Error, stored.Stage) {
				t.Fatal("moderation must block unchanged retry")
			}
		})
	}
}
