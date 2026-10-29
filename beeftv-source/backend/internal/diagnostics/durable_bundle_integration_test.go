package diagnostics_test

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/assistantdiagnostics"
	"infinite-canvas/backend/internal/diagnostics"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/supporttrace"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type unendedTurnTrace struct{ stamp time.Time }

func (f unendedTurnTrace) Snapshot(userID string, _, _ time.Time) (supporttrace.Snapshot, error) {
	return supporttrace.Snapshot{Coverage: supporttrace.Coverage{Status: "complete", Records: 1}, Events: []supporttrace.Event{{ID: "turn-start", Fields: supporttrace.Fields{UserID: userID}, Name: "assistant.turn", Phase: "start", SpanID: "unfinished-span", TraceID: "unfinished-trace", Timestamp: f.stamp}}}, nil
}

// Exercise the pinned-Durable reader, owner-scoped exporter and offline ZIP
// analyzer together. The fixture has real entries.record model-message shape;
// no runtime or model execution is opened to manufacture the verdict.
func TestDurableModelResponseInterruptionsSurviveOfflineBundleWithoutInventingTurn(t *testing.T) {
	for _, stop := range []string{"aborted", "interrupted", "error", ""} {
		t.Run("stop="+stop, func(t *testing.T) {
			dir := t.TempDir()
			now := time.Now().UTC().Truncate(time.Millisecond)
			const canvasID = "test-canvas"
			const sessionID = "durable:11111111-2222-3333-4444-555555555555"
			const turnID = "112233445566778899aabbcc"
			db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "workspace.db")), &gorm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			sqlDB, err := db.DB()
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := sqlDB.Close(); err != nil {
					t.Errorf("close diagnostic workspace database: %v", err)
				}
			})
			if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.ApiCallLog{}, &model.CanvasProject{}, &model.AssistantTurn{}); err != nil {
				t.Fatal(err)
			}
			turn := model.AssistantTurn{TurnID: turnID, UserID: "owner", CanvasID: canvasID, DurableSessionID: sessionID, State: "settled", CreatedAt: now.Add(-time.Minute), UpdatedAt: now}
			if err := db.Create(&turn).Error; err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256([]byte(canvasID))
			directory := filepath.Join(dir, "sessions", hex.EncodeToString(hash[:])[:24], "durable")
			if err := os.MkdirAll(directory, 0700); err != nil {
				t.Fatal(err)
			}
			base := strings.TrimPrefix(sessionID, "durable:")
			pin, err := json.Marshal(map[string]string{"canvasId": canvasID, "sessionId": sessionID, "version": "1.0.4"})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(directory, base+".json"), pin, 0600); err != nil {
				t.Fatal(err)
			}
			runtimeDB, err := sql.Open("sqlite3", filepath.Join(directory, base+".sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			for _, statement := range []string{"CREATE TABLE durable_schema(singleton INTEGER,version INTEGER)", "INSERT INTO durable_schema VALUES(1,1)", "CREATE TABLE entries(id INTEGER,commit_seq INTEGER,record TEXT)"} {
				if _, err := runtimeDB.Exec(statement); err != nil {
					runtimeDB.Close()
					t.Fatal(err)
				}
			}
			entry, err := json.Marshal(map[string]any{"model": []any{
				map[string]any{"role": "user", "timestamp": now.UnixMilli(), "content": "PRIVATE_PROMPT"},
				map[string]any{"role": "assistant", "timestamp": now.UnixMilli(), "model": "test-model", "stopReason": stop, "durationMs": 42, "errorMessage": "PRIVATE_ERROR", "content": []any{map[string]string{"type": "thinking", "thinking": "PRIVATE_REASONING"}}},
			}})
			if err != nil {
				runtimeDB.Close()
				t.Fatal(err)
			}
			if _, err := runtimeDB.Exec("INSERT INTO entries VALUES(1,1,?)", string(entry)); err != nil {
				runtimeDB.Close()
				t.Fatal(err)
			}
			if err := runtimeDB.Close(); err != nil {
				t.Fatal(err)
			}
			svc := diagnostics.New(diagnostics.Dependencies{Store: repository.New(db), DataDir: dir, AssistantEvidence: assistantdiagnostics.New(dir), TraceSource: unendedTurnTrace{stamp: now}})
			bundle, err := svc.Export("owner", diagnostics.ExportRequest{})
			if err != nil {
				t.Fatal(err)
			}
			archive, err := zip.NewReader(bytes.NewReader(bundle.Data), int64(len(bundle.Data)))
			if err != nil {
				t.Fatal(err)
			}
			files := map[string]string{}
			for _, file := range archive.File {
				reader, err := file.Open()
				if err != nil {
					t.Fatal(err)
				}
				body, err := io.ReadAll(reader)
				reader.Close()
				if err != nil {
					t.Fatal(err)
				}
				files[file.Name] = string(body)
				if strings.Contains(string(body), "PRIVATE_") || strings.Contains(string(body), dir) {
					t.Fatal("private runtime content exported")
				}
			}
			var record diagnostics.AssistantRuntimeEvidence
			if err := json.Unmarshal([]byte(strings.TrimSpace(files["backend/assistant-runtime.jsonl"])), &record); err != nil {
				t.Fatal(err)
			}
			if record.TurnID != "" || record.SessionID != sessionID || record.CanvasID != canvasID || record.Reason != "turn_link_not_recorded" || record.Status != stop {
				t.Fatalf("runtime metadata changed: %+v", record)
			}
			findings, err := diagnostics.AnalyzeBundle(bundle.Data)
			if err != nil {
				t.Fatal(err)
			}
			interruptions := 0
			unfinished := 0
			for _, finding := range findings {
				if finding.Reason == "operation_end_not_recorded" {
					unfinished++
					if finding.Status != "inconclusive" {
						t.Fatal("missing end claimed a confirmed interruption")
					}
				}
				if finding.Reason == "model_attempt_interrupted" {
					interruptions++
					if finding.Status != "confirmed" || finding.Stage != "assistant_model" {
						t.Fatalf("bad interruption observation: %+v", finding)
					}
					if len(finding.EvidenceRefs) != 1 || finding.EvidenceRefs[0] != "backend/assistant-runtime.jsonl#"+record.ID {
						t.Fatalf("no exact response evidence: %+v", finding)
					}
					if !strings.Contains(finding.Explanation, "这次模型尝试") || !strings.Contains(finding.Explanation, "不能据此") {
						t.Fatalf("unsupported root-cause claim: %+v", finding)
					}
				}
				if finding.Reason == "assistant_interrupted" {
					t.Fatalf("guessed business-turn interruption: %+v", finding)
				}
			}
			expected := 0
			if stop == "aborted" || stop == "interrupted" {
				expected = 1
			}
			if interruptions != expected {
				t.Fatalf("stop=%q got %d interruption observations", stop, interruptions)
			}
			if unfinished != 1 {
				t.Fatal("missing operation end was not reported honestly")
			}
			if stop == "aborted" {
				var changed bytes.Buffer
				writer := zip.NewWriter(&changed)
				for path, body := range files {
					file, err := writer.Create(path)
					if err != nil {
						t.Fatal(err)
					}
					if path != "backend/assistant-turns.jsonl" {
						if _, err := io.WriteString(file, body); err != nil {
							t.Fatal(err)
						}
					}
				}
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
				withoutOwnership, err := diagnostics.AnalyzeBundle(changed.Bytes())
				if err != nil {
					t.Fatal(err)
				}
				for _, finding := range withoutOwnership {
					if finding.Reason == "model_attempt_interrupted" {
						t.Fatal("unassociated response claimed to belong to an assistant session")
					}
				}
			}
		})
	}
}
