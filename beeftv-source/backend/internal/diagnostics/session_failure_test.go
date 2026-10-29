package diagnostics

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestNativeSessionFailureRecordsAreReportedWithoutGuessingBusinessTurn(t *testing.T) {
	body, err := os.ReadFile("testdata/native-assistant-session-failures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Turns   []AssistantTurnEvidence
		Records []AssistantRuntimeEvidence
	}
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, foreign := range []bool{false, true} {
		t.Run(map[bool]string{false: "owned", true: "unassociated"}[foreign], func(t *testing.T) {
			records := slices.Clone(fixture.Records)
			// A later successful operation with the same tool name has a different
			// operation identity; it cannot erase the failed operation's history.
			for _, name := range []string{"plan_update", "canvas_nodes_create"} {
				records = append(records, AssistantRuntimeEvidence{ID: "later-" + name, SessionID: "durable:native-session", CanvasID: "native-canvas", Kind: "tool", Name: name, Status: "completed", OperationID: "other-operation-" + name, Timestamp: fixture.Records[len(fixture.Records)-1].Timestamp.Add(time.Second)})
			}
			turns := slices.Clone(fixture.Turns)
			if foreign {
				turns[0].SessionID = "different-session"
			}
			c := &collection{AssistantTurns: turns, AssistantEvidence: records, Collectors: map[string]CollectorCoverage{"assistantTurns": {Status: "complete"}, "assistantRuntime": {Status: "partial", Reason: "runtime_history_partial"}}}
			data, err := buildZIP("BeefTV", "DIAG_NATIVE", manifest{SchemaVersion: 3, Collectors: c.Collectors}, c)
			if err != nil {
				t.Fatal(err)
			}
			findings, err := AnalyzeBundle(data)
			if err != nil {
				t.Fatal(err)
			}
			failed := map[string]bool{}
			for _, finding := range findings {
				if finding.Status != "confirmed" {
					continue
				}
				if foreign {
					t.Fatalf("unassociated session claimed owned: %+v", finding)
				}
				if !slices.Contains(finding.MissingEvidence, "assistant_turn_link") {
					t.Fatalf("guessed turn: %+v", finding)
				}
				if finding.Reason != "assistant_tool_failed" && finding.Reason != "model_attempt_failed" {
					t.Fatalf("guessed interruption or cause: %+v", finding)
				}
				if len(finding.EvidenceRefs) != 1 {
					t.Fatalf("missing exact record: %+v", finding)
				}
				failed[finding.EvidenceRefs[0]] = true
			}
			if !foreign {
				for _, id := range []string{"native:entry:37:0", "native:entry:39:0", "native:entry:41:0"} {
					if !failed["backend/assistant-runtime.jsonl#"+id] {
						t.Fatalf("failed native record omitted: %s", id)
					}
				}
				if len(failed) != 3 {
					t.Fatalf("wrong failure count: %v", failed)
				}
				assertFindingReferences(t, readTestZIP(t, data), findings)
			}
		})
	}
}

type runtimeCoverageFixture struct {
	coverage CollectorCoverage
	records  []AssistantRuntimeEvidence
}

func (f runtimeCoverageFixture) DiagnosticAssistantEvidence(string, time.Time, time.Time, []AssistantTurnEvidence) (AssistantEvidenceSnapshot, error) {
	return AssistantEvidenceSnapshot{Coverage: f.coverage, Records: f.records}, nil
}

func TestAssistantCollectorPreservesDistinctCoverageReasons(t *testing.T) {
	for _, test := range []CollectorCoverage{
		{Status: "unavailable", Reason: "no_owned_durable_sessions"},
		{Status: "partial", Reason: "dispatch_record_invalid"},
		{Status: "failed", Reason: "runtime_metadata_unavailable"},
		{Status: "partial", Reason: "runtime_history_partial"},
	} {
		t.Run(test.Status+"/"+test.Reason, func(t *testing.T) {
			svc := New(Dependencies{Store: repository.New(evidenceDB(t)), AssistantEvidence: runtimeCoverageFixture{coverage: test}})
			bundle, err := svc.Export("owner", ExportRequest{})
			if err != nil {
				t.Fatal(err)
			}
			files := readTestZIP(t, bundle.Data)
			var metadata manifest
			if err := json.Unmarshal([]byte(files["manifest.json"]), &metadata); err != nil {
				t.Fatal(err)
			}
			coverage := metadata.Collectors["assistantRuntime"]
			if coverage.Status != test.Status || coverage.Reason != test.Reason {
				t.Fatalf("specific read status hidden: %+v", coverage)
			}
			if test.Status == "unavailable" && strings.Contains(files["manifest.json"], "runtime_history_partial") {
				t.Fatal("empty owned-session scope claimed corrupt history")
			}
		})
	}
}

func TestAssistantFailureReasonIsAllowlistedAcrossExportAndOfflineAnalysis(t *testing.T) {
	for _, code := range []string{"skill_context_unavailable", "skill_context_unavailable token=PRIVATE_SECRET", "PRIVATE_UNKNOWN_REASON"} {
		t.Run(code, func(t *testing.T) {
			db := evidenceDB(t)
			now := time.Now().UTC()
			createEvidence(t, db, &model.AssistantTurn{TurnID: "business-turn", UserID: "owner", CanvasID: "canvas", DurableSessionID: "session", State: "settled", CreatedAt: now, UpdatedAt: now})
			provider := runtimeCoverageFixture{coverage: CollectorCoverage{Status: "partial", Reason: "runtime_history_partial"}, records: []AssistantRuntimeEvidence{{ID: "response", SessionID: "session", CanvasID: "canvas", Kind: "model_call", Name: "model.response", Status: "error", Reason: "turn_link_not_recorded", FailureReason: code, Timestamp: now}}}
			svc := New(Dependencies{Store: repository.New(db), AssistantEvidence: provider})
			bundle, err := svc.Export("owner", ExportRequest{})
			if err != nil {
				t.Fatal(err)
			}
			files := readTestZIP(t, bundle.Data)
			var record AssistantRuntimeEvidence
			if err := json.Unmarshal([]byte(strings.TrimSpace(files["backend/assistant-runtime.jsonl"])), &record); err != nil {
				t.Fatal(err)
			}
			expectedCode := ""
			expectedReason := "model_attempt_failed"
			if code == "skill_context_unavailable" {
				expectedCode, expectedReason = code, code
			}
			if record.FailureReason != expectedCode || record.Reason != "turn_link_not_recorded" {
				t.Fatalf("unsafe or lost reason: %+v", record)
			}
			for _, body := range files {
				if strings.Contains(body, "PRIVATE_") {
					t.Fatal("raw failure detail leaked")
				}
			}
			findings, err := AnalyzeBundle(bundle.Data)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, finding := range findings {
				if finding.Reason == expectedReason && finding.Status == "confirmed" {
					found = true
					if !slices.Contains(finding.MissingEvidence, "assistant_turn_link") {
						t.Fatal("machine cause hid missing turn linkage")
					}
				}
			}
			if !found {
				t.Fatalf("no usable failure observation for %q", expectedReason)
			}
		})
	}
}
