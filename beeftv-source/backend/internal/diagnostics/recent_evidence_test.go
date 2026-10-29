package diagnostics

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestExportLimitsKeepLatestFailuresIncludingOldTasksUpdatedNow(t *testing.T) {
	db := evidenceDB(t)
	now := time.Now().UTC().Truncate(time.Second)
	old := now.Add(-2 * time.Hour)
	var tasks []model.Task
	var turns []model.AssistantTurn
	for i := 0; i < 102; i++ {
		tasks = append(tasks, model.Task{ID: fmt.Sprintf("old-task-%03d", i), UserID: "owner", Status: model.TaskStatusSucceeded, CreatedAt: old, UpdatedAt: old})
		turns = append(turns, model.AssistantTurn{TurnID: fmt.Sprintf("old-turn-%03d", i), UserID: "owner", CanvasID: "canvas", State: "settled", CreatedAt: old, UpdatedAt: old})
	}
	if err := db.CreateInBatches(tasks, 50).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.CreateInBatches(turns, 50).Error; err != nil {
		t.Fatal(err)
	}
	createEvidence(t, db, &model.Task{ID: "latest-failure", UserID: "owner", Status: model.TaskStatusFailed, CreatedAt: now.Add(-25 * time.Hour), UpdatedAt: now, FailureDiagnostics: &model.TaskFailureDiagnostics{Source: "local_result", ExecutionResult: "completed"}})
	createEvidence(t, db, &model.AssistantTurn{TurnID: "latest-open-turn", UserID: "owner", CanvasID: "canvas", State: "open", CreatedAt: now.Add(-25 * time.Hour), UpdatedAt: now})
	createEvidence(t, db, &model.Task{ID: "foreign-latest", UserID: "foreign", CreatedAt: now, UpdatedAt: now})
	var logs []model.TaskLog
	for i := 0; i < 2002; i++ {
		logs = append(logs, model.TaskLog{ID: fmt.Sprintf("old-log-%04d", i), UserID: "owner", CreatedAt: old})
	}
	if err := db.CreateInBatches(logs, 100).Error; err != nil {
		t.Fatal(err)
	}
	createEvidence(t, db, &model.TaskLog{ID: "latest-log-failure", UserID: "owner", TaskID: "latest-failure", Level: "error", CreatedAt: now})
	var calls []model.ApiCallLog
	for i := 0; i < 1002; i++ {
		calls = append(calls, model.ApiCallLog{ID: fmt.Sprintf("old-call-%04d", i), UserID: "owner", CreatedAt: old})
	}
	if err := db.CreateInBatches(calls, 100).Error; err != nil {
		t.Fatal(err)
	}
	createEvidence(t, db, &model.ApiCallLog{ID: "latest-call-failure", UserID: "owner", TaskID: "latest-failure", StatusCode: 500, CreatedAt: now})
	svc := New(Dependencies{Store: repository.New(db)})
	bundle, err := svc.Export("owner", ExportRequest{From: now.Add(-3 * time.Hour).Format(time.RFC3339Nano)})
	if err != nil {
		t.Fatal(err)
	}
	files := readTestZIP(t, bundle.Data)
	for path, newest := range map[string]string{"backend/tasks.jsonl": "latest-failure", "backend/task-logs.jsonl": "latest-log-failure", "backend/upstream-calls.jsonl": "latest-call-failure", "backend/assistant-turns.jsonl": "latest-open-turn"} {
		if !strings.Contains(files[path], newest) {
			t.Fatalf("latest evidence missing in %s", path)
		}
	}
	for path, oldest := range map[string]string{"backend/tasks.jsonl": "old-task-000", "backend/task-logs.jsonl": "old-log-0000", "backend/upstream-calls.jsonl": "old-call-0000", "backend/assistant-turns.jsonl": "old-turn-000"} {
		if strings.Contains(files[path], oldest) {
			t.Fatalf("oldest row displaced newer evidence in %s", path)
		}
	}
	if strings.Contains(files["backend/tasks.jsonl"], "foreign-latest") {
		t.Fatal("foreign newest task leaked")
	}
	var metadata manifest
	if err := json.Unmarshal([]byte(files["manifest.json"]), &metadata); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"tasks", "taskLogs", "upstreamCalls", "assistantTurns"} {
		if metadata.Collectors[name].Status != "truncated" || metadata.Collectors[name].OmittedAtLeast < 1 {
			t.Fatalf("missing truncation: %s", name)
		}
	}
	findings, err := AnalyzeBundle(bundle.Data)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, finding := range findings {
		if finding.Reason == "local_result_failed" && finding.Status == "confirmed" {
			found = true
		}
	}
	if !found {
		t.Fatal("latest failed task cannot be diagnosed from limited ZIP")
	}
}
