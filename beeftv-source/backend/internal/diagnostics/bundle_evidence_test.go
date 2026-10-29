package diagnostics

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/supporttrace"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type traceFixture struct {
	events []supporttrace.Event
	err    error
}

func (f traceFixture) Snapshot(string, time.Time, time.Time) (supporttrace.Snapshot, error) {
	return supporttrace.Snapshot{Events: f.events, Coverage: supporttrace.Coverage{Status: "complete", Records: len(f.events), RetentionHours: 24, MaxBytes: 1048576}}, f.err
}

type runtimeFixture struct{ records []AssistantRuntimeEvidence }

func (f runtimeFixture) DiagnosticAssistantEvidence(_ string, _, _ time.Time, _ []AssistantTurnEvidence) (AssistantEvidenceSnapshot, error) {
	return AssistantEvidenceSnapshot{Records: f.records, Coverage: CollectorCoverage{Status: "complete"}}, nil
}

func evidenceDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "evidence.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := sqlDB.Close(); err != nil {
			t.Errorf("close diagnostic fixture database: %v", err)
		}
	})
	if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.ApiCallLog{}, &model.CanvasProject{}, &model.AssistantTurn{}, &model.Resource{}, &model.Asset{}, &model.AssetVersion{}, &model.AssetRepresentation{}); err != nil {
		t.Fatal(err)
	}
	return db
}

func createEvidence(t *testing.T, db *gorm.DB, value any) {
	t.Helper()
	if err := db.Create(value).Error; err != nil {
		t.Fatal(err)
	}
}

// The assertion side reads only the ZIP. It has no access to the fixture DB,
// so a useful verdict must be backed by surviving exported evidence.
func TestBundleAloneDistinguishesFailureStagesAndBenign409(t *testing.T) {
	db := evidenceDB(t)
	now := time.Now().UTC().Truncate(time.Second)
	createEvidence(t, db, &model.Task{ID: "download", UserID: "owner", Status: model.TaskStatusFailed, CreatedAt: now, UpdatedAt: now, FailureDiagnostics: &model.TaskFailureDiagnostics{Source: "local_result", ExecutionResult: "completed"}, Prompt: "private-prompt"})
	createEvidence(t, db, &model.Task{ID: "healthy", UserID: "owner", Status: model.TaskStatusSucceeded, CreatedAt: now, UpdatedAt: now})
	createEvidence(t, db, &model.Task{ID: "upstream-denied", UserID: "owner", Status: model.TaskStatusFailed, CreatedAt: now, UpdatedAt: now, FailureDiagnostics: &model.TaskFailureDiagnostics{Source: "upstream_http", HTTPStatus: 400, ExecutionResult: "rejected"}})
	createEvidence(t, db, &model.AssistantTurn{TurnID: "open-turn", UserID: "owner", CanvasID: "canvas", DurableSessionID: "session", State: "open", CreatedAt: now, UpdatedAt: now, Document: "private-thinking", CanvasSnapshotsJSON: `{"nodes":["private-text"]}`})
	createEvidence(t, db, &model.AssistantTurn{TurnID: "other-turn", UserID: "other-owner", CanvasID: "private-canvas", DurableSessionID: "private-session", State: "open", CreatedAt: now, UpdatedAt: now})
	trace := traceFixture{events: []supporttrace.Event{
		{ID: "write-failed", Fields: supporttrace.Fields{UserID: "owner", TaskID: "write-task", Reason: "disk_full"}, Name: "generation.persist", Phase: "end", Status: "error", Timestamp: now},
		{ID: "foreign-event", Fields: supporttrace.Fields{UserID: "other-owner", TaskID: "foreign-task"}, Name: "generation.persist", Phase: "end", Status: "error", Timestamp: now},
	}}
	runtime := runtimeFixture{records: []AssistantRuntimeEvidence{
		{ID: "interrupted", SessionID: "session", TurnID: "open-turn", CanvasID: "canvas", Kind: "recovery", Name: "durable.task", Status: "interrupted", Timestamp: now},
		{ID: "unlinked-response", SessionID: "session", CanvasID: "canvas", Kind: "model_call", Name: "model.response", Reason: "turn_link_not_recorded", Status: "completed", Timestamp: now},
		{ID: "foreign-runtime", SessionID: "private-session", TurnID: "other-turn", CanvasID: "private-canvas", Kind: "model_call", Timestamp: now},
	}}
	svc := New(Dependencies{Store: repository.New(db), TraceSource: trace, AssistantEvidence: runtime, Now: func() time.Time { return now.Add(time.Second) }})
	bindings := func(node string) *CanvasBindingEvidence {
		return &CanvasBindingEvidence{Source: "client", NodeID: node, ClientOperationID: "op"}
	}
	bundle, err := svc.Export("owner", ExportRequest{From: now.Add(-time.Minute).Format(time.RFC3339), To: now.Add(time.Second).Format(time.RFC3339), ClientCoverage: &ClientCoverage{Status: "available", Persisted: true}, ClientEvents: []ClientEvent{
		{ID: "stale-document", Timestamp: now.Format(time.RFC3339), TaskID: "healthy", Code: "canvas_document_commit_failed", HTTPStatus: 409, Reason: "stale_revision"},
		{ID: "refused-then-recovered", Timestamp: now.Format(time.RFC3339), TaskID: "healthy", Code: "generation_bind_refused", Reason: "stale_revision", CanvasBinding: bindings("healthy-node")},
		{ID: "confirmed", Timestamp: now.Add(time.Second).Format(time.RFC3339), TaskID: "healthy", Code: "generation_bind_confirmed", CanvasBinding: bindings("healthy-node")},
		{ID: "wrong-node", Timestamp: now.Format(time.RFC3339), TaskID: "download", Code: "generation_bind_refused", Reason: "node_task_mismatch", CanvasBinding: bindings("missing-node")},
	}})
	if err != nil {
		t.Fatal(err)
	}
	files := readTestZIP(t, bundle.Data)
	all := ""
	for _, value := range files {
		all += value
	}
	for _, secret := range []string{"owner", "private-prompt", "private-thinking", "private-text", "private-canvas", "private-session", "foreign-event", "foreign-runtime", "userId"} {
		if strings.Contains(all, secret) {
			t.Fatalf("leaked %s", secret)
		}
	}
	if !strings.Contains(files["backend/assistant-runtime.jsonl"], "unlinked-response") {
		t.Fatal("missing honestly unlinked historical evidence")
	}
	findings, err := AnalyzeBundle(bundle.Data)
	if err != nil {
		t.Fatal(err)
	}
	byReason := map[string]Finding{}
	for _, finding := range findings {
		byReason[finding.Reason] = finding
	}
	for _, reason := range []string{"local_result_failed", "node_task_mismatch", "disk_full", "assistant_interrupted", "upstream_request_failed"} {
		if byReason[reason].Status != "confirmed" {
			t.Fatalf("could not infer %s from ZIP: %+v", reason, findings)
		}
	}
	if _, exists := byReason["stale_revision"]; exists {
		t.Fatal("benign recovered 409 was called a cause")
	}
	if byReason["assistant_turn_unsettled"].Status != "inconclusive" {
		t.Fatal("an open turn was treated as proof of a crash")
	}
	assertFindingReferences(t, files, findings)
}

func assertFindingReferences(t *testing.T, files map[string]string, findings []Finding) {
	t.Helper()
	for _, finding := range findings {
		for _, ref := range finding.EvidenceRefs {
			parts := strings.SplitN(ref, "#", 2)
			body, exists := files[parts[0]]
			if !exists {
				t.Fatalf("dangling evidence %s", ref)
			}
			if len(parts) == 2 && !strings.HasPrefix(parts[1], "/") && !strings.Contains(body, `"id":"`+parts[1]+`"`) {
				t.Fatalf("missing evidence id %s", ref)
			}
		}
	}
}

type failingLogStore struct{ Store }

func (f failingLogStore) DiagnosticTaskLogs(string, time.Time, time.Time, string, string) ([]model.TaskLog, error) {
	return nil, errors.New("secret OS path and token=never-export")
}

func TestCollectorFailureIsVisibleWithoutLeakingErrorOrFailingBundle(t *testing.T) {
	db := evidenceDB(t)
	svc := New(Dependencies{Store: failingLogStore{Store: repository.New(db)}, TraceSource: traceFixture{err: errors.New("apiKey=trace-secret")}})
	bundle, err := svc.Export("owner", ExportRequest{})
	if err != nil {
		t.Fatal(err)
	}
	files := readTestZIP(t, bundle.Data)
	var metadata manifest
	if err := json.Unmarshal([]byte(files["manifest.json"]), &metadata); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"taskLogs", "backendEvents"} {
		if metadata.Collectors[name].Status != "failed" {
			t.Fatalf("%s pretended complete", name)
		}
	}
	if metadata.Collectors["assistantTurns"].Status != "unavailable" {
		t.Fatal("missing optional collector pretended complete")
	}
	for _, body := range files {
		if strings.Contains(body, "never-export") || strings.Contains(body, "trace-secret") {
			t.Fatal("collector error leaked")
		}
	}
	if _, err := svc.Export("", ExportRequest{}); err == nil {
		t.Fatal("empty owner allowed")
	}
	denied := New(Dependencies{Store: repository.New(db), TraceSource: traceFixture{err: kernel.Forbidden("owner rejected")}})
	if _, err := denied.Export("owner", ExportRequest{}); err == nil {
		t.Fatal("authorization failure was disguised as partial collection")
	}
}

func TestRealQueryLimitsReportOmissionAndOwnerScope(t *testing.T) {
	db := evidenceDB(t)
	now := time.Now().UTC()
	for index := 0; index < 101; index++ {
		createEvidence(t, db, &model.Task{ID: fmt.Sprintf("t-%03d", index), UserID: "owner", CreatedAt: now, UpdatedAt: now})
	}
	createEvidence(t, db, &model.Task{ID: "foreign", UserID: "other", CreatedAt: now, UpdatedAt: now})
	var logs []model.TaskLog
	for index := 0; index < 2001; index++ {
		logs = append(logs, model.TaskLog{ID: fmt.Sprintf("l-%04d", index), UserID: "owner", TaskID: "t-000", CreatedAt: now})
	}
	if err := db.CreateInBatches(logs, 100).Error; err != nil {
		t.Fatal(err)
	}
	var calls []model.ApiCallLog
	for index := 0; index < 1001; index++ {
		calls = append(calls, model.ApiCallLog{ID: fmt.Sprintf("c-%04d", index), UserID: "owner", CreatedAt: now})
	}
	if err := db.CreateInBatches(calls, 100).Error; err != nil {
		t.Fatal(err)
	}
	svc := New(Dependencies{Store: repository.New(db)})
	bundle, err := svc.Export("owner", ExportRequest{})
	if err != nil {
		t.Fatal(err)
	}
	files := readTestZIP(t, bundle.Data)
	var metadata manifest
	if err := json.Unmarshal([]byte(files["manifest.json"]), &metadata); err != nil {
		t.Fatal(err)
	}
	for name, limit := range map[string]int{"tasks": 100, "taskLogs": 2000, "upstreamCalls": 1000} {
		coverage := metadata.Collectors[name]
		if coverage.Status != "truncated" || coverage.Records != limit || coverage.OmittedAtLeast != 1 {
			t.Fatalf("%s: %+v", name, coverage)
		}
	}
	if !metadata.Truncated || strings.Contains(files["backend/tasks.jsonl"], "foreign") {
		t.Fatal("missing truncation or owner isolation")
	}
	if _, err := svc.Export("owner", ExportRequest{TaskID: "foreign"}); err == nil {
		t.Fatal("foreign root task allowed")
	}
	createEvidence(t, db, &model.CanvasProject{ID: "foreign-canvas", UserID: "other"})
	if _, err := svc.Export("owner", ExportRequest{ProjectID: "foreign-canvas"}); err == nil {
		t.Fatal("foreign canvas allowed")
	}
}

func TestBundleSizeReductionUpdatesCoverageAndReferences(t *testing.T) {
	now := time.Now().UTC()
	c := &collection{Window: timeWindow{From: now.Add(-time.Hour), To: now}, Collectors: map[string]CollectorCoverage{}}
	for index := 0; index < 120; index++ {
		raw := make([]byte, 3000)
		if _, err := rand.Read(raw); err != nil {
			t.Fatal(err)
		}
		c.ClientEvents = append(c.ClientEvents, clientEventRecord{ID: fmt.Sprintf("e-%03d", index), Message: hex.EncodeToString(raw)})
	}
	c.setCoverage("clientEvents", len(c.ClientEvents), 500, nil)
	data, err := buildBoundedZIP("BeefTV", "DIAG_SIZE", manifest{SchemaVersion: SchemaVersion}, c, 60000)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > 60000 {
		t.Fatal("byte bound exceeded")
	}
	files := readTestZIP(t, data)
	var metadata manifest
	if err := json.Unmarshal([]byte(files["manifest.json"]), &metadata); err != nil {
		t.Fatal(err)
	}
	coverage := metadata.Collectors["clientEvents"]
	if !metadata.Truncated || coverage.Reason != "bundle_byte_limit" || coverage.OmittedAtLeast == 0 || coverage.Records+int(coverage.OmittedAtLeast) != 120 {
		t.Fatalf("dishonest byte coverage: %+v", coverage)
	}
	findings, err := AnalyzeBundle(data)
	if err != nil {
		t.Fatal(err)
	}
	assertFindingReferences(t, files, findings)
}

func TestResourcesCheckOnlyOwnedLocalFilesAndNeverExportPaths(t *testing.T) {
	db := evidenceDB(t)
	now := time.Now().UTC()
	createEvidence(t, db, &model.Task{ID: "task", UserID: "owner", Status: model.TaskStatusSucceeded, CreatedAt: now, UpdatedAt: now})
	createEvidence(t, db, &model.Asset{ID: "asset", UserID: "owner"})
	createEvidence(t, db, &model.AssetVersion{ID: "version", AssetID: "asset"})
	createEvidence(t, db, &model.Resource{ID: "missing", UserID: "owner", Provider: "local", ObjectKey: "sensitive-name.mp4", Kind: "video", Status: model.ResourceStatusReady, Size: 100})
	createEvidence(t, db, &model.AssetRepresentation{ID: "output", TaskID: "task", AssetVersionID: "version", ResourceID: "missing", Role: "primary"})
	createEvidence(t, db, &model.Resource{ID: "foreign-resource", UserID: "other", ObjectKey: "secret-foreign-path", Provider: "local", Size: 997})
	createEvidence(t, db, &model.AssetRepresentation{ID: "foreign-reference", TaskID: "task", AssetVersionID: "version", ResourceID: "foreign-resource", Role: "foreign"})
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "resources"), 0700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "private-file")
	if err := os.WriteFile(outside, []byte("private-file-content"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "resources", "escape")); err == nil {
		createEvidence(t, db, &model.Resource{ID: "escape-resource", UserID: "owner", Provider: "local", ObjectKey: "escape", Status: model.ResourceStatusReady})
		createEvidence(t, db, &model.AssetRepresentation{ID: "escape-output", TaskID: "task", AssetVersionID: "version", ResourceID: "escape-resource", Role: "escape"})
	}
	svc := New(Dependencies{Store: repository.New(db), DataDir: dir})
	bundle, err := svc.Export("owner", ExportRequest{TaskID: "task"})
	if err != nil {
		t.Fatal(err)
	}
	files := readTestZIP(t, bundle.Data)
	for _, body := range files {
		if strings.Contains(body, "sensitive-name") || strings.Contains(body, "secret-foreign-path") || strings.Contains(body, dir) {
			t.Fatal("resource path leaked")
		}
	}
	findings, err := AnalyzeBundle(bundle.Data)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, finding := range findings {
		if finding.Reason == "ready_resource_file_missing" {
			found = true
		}
	}
	if !found {
		t.Fatal("ZIP could not reveal missing local file")
	}
	if strings.Contains(files["backend/resources.jsonl"], `"recordedSize":997`) {
		t.Fatal("foreign resource metadata was read")
	}
	for _, line := range strings.Split(files["backend/resources.jsonl"], "\n") {
		if strings.Contains(line, "escape-output") && strings.Contains(line, `"fileSize"`) {
			t.Fatal("symlink escaped resource root")
		}
	}
	assertFindingReferences(t, files, findings)
}

func TestAssistantQueryUsesExactTaskMembershipOwnerAndWindow(t *testing.T) {
	db := evidenceDB(t)
	now := time.Now().UTC()
	for _, turn := range []model.AssistantTurn{
		{TurnID: "selected", UserID: "owner", CanvasID: "canvas", AssociatedTaskIDs: `["task-real"]`, CreatedAt: now, UpdatedAt: now},
		{TurnID: "similar", UserID: "owner", CanvasID: "canvas", AssociatedTaskIDs: `["task-real-extra"]`, CreatedAt: now, UpdatedAt: now},
		{TurnID: "foreign", UserID: "other", CanvasID: "canvas", AssociatedTaskIDs: `["task-real"]`, CreatedAt: now.Add(-time.Hour), UpdatedAt: now},
		{TurnID: "old", UserID: "owner", CanvasID: "canvas", AssociatedTaskIDs: `["task-real"]`, CreatedAt: now.Add(-time.Hour), UpdatedAt: now.Add(-time.Hour)},
	} {
		createEvidence(t, db, &turn)
	}
	turns, err := repository.New(db).DiagnosticAssistantTurns("owner", now.Add(-time.Minute), now.Add(time.Minute), "canvas", "task-real")
	if err != nil || len(turns) != 1 || turns[0].TurnID != "selected" {
		t.Fatalf("turn scope = %+v, %v", turns, err)
	}
}
