package diagnostics

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/supporttrace"
)

type partialTraceFixture struct {
	snapshot supporttrace.Snapshot
	err      error
}

func (f partialTraceFixture) Snapshot(string, time.Time, time.Time) (supporttrace.Snapshot, error) {
	return f.snapshot, f.err
}

func TestTraceReadErrorsPreserveValidScopedEvidenceAndLossCounters(t *testing.T) {
	for _, test := range []struct {
		name                 string
		valid                bool
		readError            bool
		dropped, writeErrors int64
		status               string
	}{
		{name: "read prefix", valid: true, readError: true, status: "partial"},
		{name: "read prefix and losses", valid: true, readError: true, dropped: 2, writeErrors: 3, status: "truncated"},
		{name: "retention and writes", valid: true, dropped: 2, writeErrors: 3, status: "truncated"},
		{name: "no readable owned records", readError: true, status: "failed"},
		{name: "no readable records despite retention", readError: true, dropped: 2, writeErrors: 3, status: "failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := evidenceDB(t)
			now := time.Now().UTC()
			createEvidence(t, db, &model.Task{ID: "task", UserID: "owner", CreatedAt: now, UpdatedAt: now})
			events := []supporttrace.Event{
				{ID: "foreign-secret", Fields: supporttrace.Fields{UserID: "foreign", TaskID: "task"}, Timestamp: now},
				{ID: "old-secret", Fields: supporttrace.Fields{UserID: "owner", TaskID: "task"}, Timestamp: now.Add(-time.Hour)},
				{ID: "other-task-secret", Fields: supporttrace.Fields{UserID: "owner", TaskID: "other-task"}, Timestamp: now},
			}
			if test.valid {
				events = append(events, supporttrace.Event{ID: "saved-before-corruption", Fields: supporttrace.Fields{UserID: "owner", TaskID: "task", Reason: "local_disk_full"}, Name: "generation.persist", Phase: "end", Status: "error", Timestamp: now})
			}
			source := partialTraceFixture{snapshot: supporttrace.Snapshot{Events: events, Coverage: supporttrace.Coverage{Status: "complete", Records: len(events), Dropped: test.dropped, WriteErrors: test.writeErrors}}}
			if test.readError {
				source.err = errors.New("token=PRIVATE_READER_ERROR")
			}
			service := New(Dependencies{Store: repository.New(db), TraceSource: source})
			bundle, err := service.Export("owner", ExportRequest{TaskID: "task"})
			if err != nil {
				t.Fatal(err)
			}
			files := readTestZIP(t, bundle.Data)
			var manifest manifest
			if err := json.Unmarshal([]byte(files["manifest.json"]), &manifest); err != nil {
				t.Fatal(err)
			}
			coverage := manifest.Collectors["backendEvents"]
			expectedRecords := 0
			if test.valid {
				expectedRecords = 1
			}
			if coverage.Status != test.status || coverage.Records != expectedRecords || coverage.OmittedAtLeast != test.dropped {
				t.Fatalf("coverage = %+v", coverage)
			}
			var sourceCoverage supporttrace.Coverage
			if err := json.Unmarshal([]byte(files["backend/event-coverage.json"]), &sourceCoverage); err != nil {
				t.Fatal(err)
			}
			if sourceCoverage.Dropped != test.dropped || sourceCoverage.WriteErrors != test.writeErrors {
				t.Fatalf("loss counters discarded: %+v", sourceCoverage)
			}
			if test.valid && !strings.Contains(files["backend/events.jsonl"], "saved-before-corruption") {
				t.Fatal("valid prefix was lost")
			}
			for _, file := range files {
				for _, private := range []string{"foreign-secret", "old-secret", "other-task-secret", "PRIVATE_READER_ERROR"} {
					if strings.Contains(file, private) {
						t.Fatalf("out-of-scope or private value exported: %s", private)
					}
				}
			}
			findings, err := AnalyzeBundle(bundle.Data)
			if err != nil {
				t.Fatal(err)
			}
			if test.valid {
				found := false
				for _, finding := range findings {
					if finding.Reason == "local_disk_full" && finding.Status == "confirmed" {
						found = true
					}
				}
				if !found {
					t.Fatal("partial read lost usable diagnosis")
				}
			}
		})
	}
}
