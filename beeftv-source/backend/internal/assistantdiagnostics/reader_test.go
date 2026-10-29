package assistantdiagnostics

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/diagnostics"
)

func fixture(t *testing.T) (string, diagnostics.AssistantTurnEvidence, time.Time) {
	t.Helper()
	dir := t.TempDir()
	stamp := time.Now().UTC().Truncate(time.Millisecond)
	turn := diagnostics.AssistantTurnEvidence{ID: "112233445566778899aabbcc", SessionID: "durable:11111111-2222-3333-4444-555555555555", CanvasID: "canvas-private-1", CreatedAt: stamp.Add(-time.Minute), UpdatedAt: stamp}
	hash := sha256.Sum256([]byte(turn.CanvasID))
	d := filepath.Join(dir, "sessions", hex.EncodeToString(hash[:])[:24], "durable")
	if err := os.MkdirAll(d, 0700); err != nil {
		t.Fatal(err)
	}
	base := strings.TrimPrefix(turn.SessionID, "durable:")
	body, _ := json.Marshal(map[string]string{"canvasId": turn.CanvasID, "sessionId": turn.SessionID, "version": "1.0.4"})
	if err := os.WriteFile(filepath.Join(d, base+".json"), body, 0600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite3", filepath.Join(d, base+".sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{"CREATE TABLE durable_schema(singleton INTEGER,version INTEGER)", "INSERT INTO durable_schema VALUES(1,1)", "CREATE TABLE entries(id INTEGER,commit_seq INTEGER,record TEXT)"} {
		if _, err = db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	record, _ := json.Marshal(map[string]any{"model": []any{
		map[string]any{"role": "user", "timestamp": stamp.UnixMilli(), "content": "PRIVATE_PROMPT_MUST_NOT_EXPORT"},
		map[string]any{"role": "assistant", "timestamp": stamp.UnixMilli(), "model": "model-1", "stopReason": "toolUse", "durationMs": 123, "content": []any{map[string]string{"type": "thinking", "thinking": "PRIVATE_REASONING_MUST_NOT_EXPORT"}}},
		map[string]any{"role": "toolResult", "timestamp": stamp.UnixMilli(), "toolName": "canvas_read", "toolCallId": "call_123456", "isError": false, "content": "PRIVATE_TOOL_RESULT_MUST_NOT_EXPORT"},
	}})
	if _, err = db.Exec("INSERT INTO entries VALUES(1,1,?)", string(record)); err != nil {
		t.Fatal(err)
	}
	return dir, turn, stamp
}

func TestExistingDurableMetadataIsReadWithoutTranscriptOrRuntimeExecution(t *testing.T) {
	dir, turn, stamp := fixture(t)
	result, err := New(dir).DiagnosticAssistantEvidence("owner-1", stamp.Add(-time.Hour), stamp.Add(time.Hour), []diagnostics.AssistantTurnEvidence{turn})
	if err != nil || len(result.Records) != 2 {
		t.Fatalf("metadata missing: %+v %v", result, err)
	}
	raw, _ := json.Marshal(result)
	if strings.Contains(string(raw), "PRIVATE_") || strings.Contains(string(raw), dir) {
		t.Fatalf("private history exported: %s", raw)
	}
	for _, r := range result.Records {
		if r.TurnID != "" || r.Reason != "turn_link_not_recorded" || r.SessionID != turn.SessionID {
			t.Fatalf("guessed turn linkage: %+v", r)
		}
	}
	if result.Coverage.Status != "partial" {
		t.Fatalf("response-only history claimed complete: %+v", result.Coverage)
	}
}

func TestDispatchRequiresExactOwnedTurnCanvasAndSession(t *testing.T) {
	dir, turn, stamp := fixture(t)
	rows := []map[string]string{
		{"id": "dispatch-one", "at": stamp.Format(time.RFC3339Nano), "turnId": turn.ID, "canvasId": turn.CanvasID, "sessionId": turn.SessionID, "model": "model-1"},
		{"id": "dispatch-foreign", "at": stamp.Format(time.RFC3339Nano), "turnId": "foreign-turn", "canvasId": turn.CanvasID, "sessionId": turn.SessionID, "model": "foreign-private-model"},
		{"id": "dispatch-wrong-canvas", "at": stamp.Format(time.RFC3339Nano), "turnId": turn.ID, "canvasId": "foreign-canvas", "sessionId": turn.SessionID},
	}
	var body []byte
	for _, row := range rows {
		b, _ := json.Marshal(row)
		body = append(append(body, b...), '\n')
	}
	if err := os.WriteFile(filepath.Join(dir, "agent-requests.jsonl"), body, 0600); err != nil {
		t.Fatal(err)
	}
	result, err := New(dir).DiagnosticAssistantEvidence("owner-1", stamp.Add(-time.Hour), stamp.Add(time.Hour), []diagnostics.AssistantTurnEvidence{turn})
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, r := range result.Records {
		if r.Name == "model.dispatch" {
			count++
			if r.TurnID != turn.ID {
				t.Fatal("foreign dispatch")
			}
		}
	}
	if count != 1 {
		t.Fatalf("scoped dispatches=%d", count)
	}
	result, err = New(dir).DiagnosticAssistantEvidence("owner-1", stamp.Add(-time.Hour), stamp.Add(time.Hour), nil)
	if err != nil || len(result.Records) != 0 {
		t.Fatalf("unowned history leaked: %+v %v", result, err)
	}
	if _, err = New(dir).DiagnosticAssistantEvidence("", stamp, stamp, nil); err == nil {
		t.Fatal("empty scope accepted")
	}
}

func TestUnmatchedManifestIsNotReadAndMissingDatabaseIsNotCreated(t *testing.T) {
	dir, turn, stamp := fixture(t)
	hash := sha256.Sum256([]byte(turn.CanvasID))
	d := filepath.Join(dir, "sessions", hex.EncodeToString(hash[:])[:24], "durable")
	base := strings.TrimPrefix(turn.SessionID, "durable:")
	file := filepath.Join(d, base+".sqlite")
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	result, err := New(dir).DiagnosticAssistantEvidence("owner-1", stamp.Add(-time.Hour), stamp.Add(time.Hour), []diagnostics.AssistantTurnEvidence{turn})
	if err != nil || len(result.Records) != 0 || result.Coverage.Status != "partial" {
		t.Fatalf("missing store incorrectly represented: %+v %v", result, err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("diagnostics created a runtime DB")
	}
	if err := os.WriteFile(filepath.Join(d, base+".json"), []byte(`{"canvasId":"other","version":"1.0.4"}`), 0600); err != nil {
		t.Fatal(err)
	}
	result, err = New(dir).DiagnosticAssistantEvidence("owner-1", stamp.Add(-time.Hour), stamp.Add(time.Hour), []diagnostics.AssistantTurnEvidence{turn})
	if err != nil || len(result.Records) != 0 {
		t.Fatal("foreign manifest accepted")
	}
}

func TestBrokenDispatchLedgerWithoutOwnedSessionsRemainsPartial(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "agent-requests.jsonl"), []byte("{broken\n"), 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	result, err := New(dir).DiagnosticAssistantEvidence("owner", now.Add(-time.Hour), now.Add(time.Hour), nil)
	if err != nil || result.Coverage.Status != "partial" || result.Coverage.Reason == "no_owned_durable_sessions" {
		t.Fatalf("read failure hidden: %+v %v", result.Coverage, err)
	}
}

func TestRuntimeFailureReasonProjectionAcceptsOnlyExactKnownMachineCodes(t *testing.T) {
	dir, turn, stamp := fixture(t)
	hash := sha256.Sum256([]byte(turn.CanvasID))
	file := filepath.Join(dir, "sessions", hex.EncodeToString(hash[:])[:24], "durable", strings.TrimPrefix(turn.SessionID, "durable:")+".sqlite")
	db, err := sql.Open("sqlite3", file)
	if err != nil {
		t.Fatal(err)
	}
	rows := []any{
		map[string]any{"role": "assistant", "timestamp": stamp.UnixMilli(), "stopReason": "error", "errorMessage": "skill_context_unavailable", "content": "PRIVATE_MODEL_BODY"},
		map[string]any{"role": "assistant", "timestamp": stamp.UnixMilli(), "stopReason": "error", "errorMessage": "skill_context_unavailable token=PRIVATE_SECRET", "content": "PRIVATE_MODEL_BODY"},
		map[string]any{"role": "assistant", "timestamp": stamp.UnixMilli(), "stopReason": "error", "errorMessage": "PRIVATE_UNKNOWN_ERROR", "content": "PRIVATE_MODEL_BODY"},
		map[string]any{"role": "toolResult", "timestamp": stamp.UnixMilli(), "toolName": "plan_update", "toolCallId": "call_failed", "isError": true, "errorMessage": "skill_context_unavailable", "content": "PRIVATE_TOOL_RESULT"},
		map[string]any{"role": "assistant", "timestamp": stamp.UnixMilli(), "stopReason": "toolUse", "errorMessage": "skill_context_unavailable", "content": "PRIVATE_MODEL_BODY"},
	}
	entry, err := json.Marshal(map[string]any{"model": rows})
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO entries VALUES(2,2,?)", string(entry)); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	result, err := New(dir).DiagnosticAssistantEvidence("owner", stamp.Add(-time.Hour), stamp.Add(time.Hour), []diagnostics.AssistantTurnEvidence{turn})
	if err != nil {
		t.Fatal(err)
	}
	known := 0
	for _, record := range result.Records {
		if record.FailureReason != "" {
			known++
			if record.FailureReason != "skill_context_unavailable" {
				t.Fatalf("unapproved error exposed: %+v", record)
			}
		}
		if record.Reason != "turn_link_not_recorded" || record.TurnID != "" {
			t.Fatal("failure reason replaced missing-turn evidence")
		}
	}
	if known != 2 {
		t.Fatalf("machine failure codes = %d", known)
	}
	body, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "PRIVATE_") || strings.Contains(string(body), "errorMessage") {
		t.Fatalf("raw error or result exported: %s", body)
	}
}
