package app

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func creationTestService(t *testing.T) (*Service, *gorm.DB, string, CreationGuard) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "creation.db")+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(database.LocalModels()...); err != nil {
		t.Fatal(err)
	}
	// Creation approvals protect local model selection and idempotent task admission.
	s := &Service{repo: repository.New(db), dataDir: t.TempDir(), mode: serviceModeLocal}
	capabilityConfig := mustEncodeModelCapabilityConfig(t, DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "text-test"))
	for _, item := range []any{&model.ModelChannel{ID: "channel", Scope: model.ChannelScopeSystem, Enabled: true, Name: "受控测试"}, &model.ChannelModel{ID: "cm", ChannelID: "channel", ModelKey: "text-test", Capability: "text", Protocol: model.ChannelInterfaceChatCompletion, CapabilityConfigJSON: capabilityConfig, Enabled: true}, &model.ChannelModelVariant{ID: "tier", ChannelModelID: "cm", SelectorKey: "{}", SelectorJSON: "{}", Enabled: true}} {
		if err = db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	detail, err := s.CreateCreationRun("user", CreationRequest{ClientKey: "client", State: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	id := detail.Run.ID
	if _, err = s.ChangeCreationRun("user", id, "claim", CreationRequest{ExpectedEpoch: 0, CreationGuard: CreationGuard{Owner: "page"}}); err != nil {
		t.Fatal(err)
	}
	return s, db, id, CreationGuard{ExecutionEpoch: 1, Owner: "page"}
}
func creationTextRequest() CreateTaskRequest {
	return CreateTaskRequest{Type: "canvas_text", Prompt: "只输出测试", Model: "text-test", Input: map[string]any{"mode": "text", "prompt": "只输出测试", "config": map[string]any{"channelId": "channel", "model": "text-test"}}}
}

func prepareApprovedCreation(t *testing.T, s *Service, id string, guard CreationGuard) *CreationSubmissionOutput {
	t.Helper()
	item, err := s.PrepareCreationSubmission("user", id, CreationRequest{CreationGuard: guard, ItemKey: "text-1", Request: creationTextRequest()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApproveCreationSubmissions("user", id, CreationRequest{CreationGuard: guard, SubmissionIDs: []string{item.ID}}); err != nil {
		t.Fatal(err)
	}
	return item
}

func TestCreationSubmissionOutputIsLocalExecutionDescriptor(t *testing.T) {
	s, _, id, guard := creationTestService(t)
	item, err := s.PrepareCreationSubmission("user", id, CreationRequest{CreationGuard: guard, ItemKey: "descriptor", Request: creationTextRequest()})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, forbidden := range []string{"quote", "billing", "amountMicrocredits", "expiresAt"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("local execution response contains %q: %s", forbidden, text)
		}
	}
	if !strings.Contains(text, `"execution"`) || item.Execution.Model != "text-test" || item.Execution.ConfigHash == "" {
		t.Fatalf("missing execution descriptor: %#v", item)
	}
}

func TestCreationExpiredLeaseRejectsConfirmAndSubmit(t *testing.T) {
	s, db, id, guard := creationTestService(t)
	past := time.Now().Add(-time.Minute)
	if err := db.Model(&model.CreationRun{}).Where("id = ?", id).Update("lease_expires_at", past).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.PrepareCreationSubmission("user", id, CreationRequest{CreationGuard: guard, ItemKey: "late", Request: creationTextRequest()}); err == nil {
		t.Fatal("expired lease quote accepted")
	}
	if _, err := s.ChangeCreationRun("user", id, "proposal-approve", CreationRequest{CreationGuard: guard, Revision: 2, ProposalVersion: 1, Proposal: json.RawMessage(`{"title":"计划"}`), Ops: []CreationCanvasOp{{Type: "add_node", ID: "n", NodeType: "text"}}}); err == nil {
		t.Fatal("expired lease confirmation accepted")
	}
}

func TestCreationModelCannotSelfConfirm(t *testing.T) {
	s, _, id, guard := creationTestService(t)
	if _, err := s.ChangeCreationRun("user", id, "release", CreationRequest{CreationGuard: guard}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ChangeCreationRun("user", id, "claim", CreationRequest{ExpectedEpoch: 1, CreationGuard: CreationGuard{Owner: "assistant"}}); err != nil {
		t.Fatal(err)
	}
	run, err := s.GetCreationRun("user", id)
	if err != nil {
		t.Fatal(err)
	}
	if run.Run.ExecutionOwner != "assistant" {
		t.Fatalf("lease owner is identity, got %q", run.Run.ExecutionOwner)
	}
}

func TestCreationRunOwnershipCASAndFence(t *testing.T) {
	s, _, id, guard := creationTestService(t)
	if _, err := s.GetCreationRun("other", id); err == nil {
		t.Fatal("cross-user read accepted")
	}
	if _, err := s.ChangeCreationRun("user", id, "save", CreationRequest{CreationGuard: guard, Revision: 1, Status: "running", State: map[string]any{}}); err == nil {
		t.Fatal("stale revision accepted")
	}
	if _, err := s.ChangeCreationRun("user", id, "save", CreationRequest{CreationGuard: guard, Revision: 2, Status: "running", State: map[string]any{"approved": true}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateRunCanvas("user", id, CreationRequest{CreationGuard: guard}); err == nil {
		t.Fatal("untrusted state approved canvas")
	}
	if _, err := s.ChangeCreationRun("user", id, "claim", CreationRequest{ExpectedEpoch: 1, CreationGuard: CreationGuard{Owner: "new-page"}}); err == nil {
		t.Fatal("foreign owner stole a live lease")
	}
	if _, err := s.ChangeCreationRun("user", id, "claim", CreationRequest{ExpectedEpoch: 1, CreationGuard: CreationGuard{Owner: "page"}}); err != nil {
		t.Fatal(err)
	}
	renewed := CreationGuard{ExecutionEpoch: 2, Owner: "page"}
	if _, err := s.ChangeCreationRun("user", id, "heartbeat", CreationRequest{CreationGuard: guard}); err == nil {
		t.Fatal("stale epoch renewed lease")
	}
	if _, err := s.ChangeCreationRun("user", id, "release", CreationRequest{CreationGuard: renewed}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ChangeCreationRun("user", id, "claim", CreationRequest{ExpectedEpoch: 2, CreationGuard: CreationGuard{Owner: "new-page"}}); err != nil {
		t.Fatal(err)
	}
}

func TestCreationSubmissionApprovalRejectsChangedExecutionConfig(t *testing.T) {
	s, db, id, guard := creationTestService(t)
	item, err := s.PrepareCreationSubmission("user", id, CreationRequest{CreationGuard: guard, ItemKey: "text-1", Request: creationTextRequest()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID}); err == nil {
		t.Fatal("unapproved task executed")
	}
	changed := creationTextRequest()
	changed.Prompt = "changed"
	changed.Input["prompt"] = "changed"
	if _, err = s.PrepareCreationSubmission("user", id, CreationRequest{CreationGuard: guard, ItemKey: "text-1", Request: changed}); err == nil {
		t.Fatal("same item accepted different request")
	}
	if err = db.Model(&model.ChannelModel{}).Where("id = ?", "cm").Updates(map[string]any{"capability_version": 2, "updated_at": time.Now().Add(time.Second)}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApproveCreationSubmissions("user", id, CreationRequest{CreationGuard: guard, SubmissionIDs: []string{item.ID}}); err == nil {
		t.Fatal("changed execution configuration approved")
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 {
		t.Fatalf("unexpected tasks: %d", count)
	}
}

func TestCreationConcurrentExecuteCreatesOneTaskAndRollsBack(t *testing.T) {
	s, db, id, guard := creationTestService(t)
	item := prepareApprovedCreation(t, s, id, guard)
	if err := db.Callback().Create().Before("gorm:create").Register("creation_force_failure", func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Name == "Task" {
			tx.AddError(creationConflict("injected failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID}); err == nil {
		t.Fatal("injected failure not propagated")
	}
	for _, table := range []any{&model.Task{}} {
		var count int64
		db.Model(table).Count(&count)
		if count != 0 {
			t.Fatalf("partial transaction committed: %T %d", table, count)
		}
	}
	var sub model.CreationSubmission
	db.First(&sub, "id = ?", item.ID)
	if sub.TaskID != nil || sub.ApprovedAt == nil {
		t.Fatal("failed admission consumed approval")
	}
	if err := db.Callback().Create().Remove("creation_force_failure"); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			task, err := s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID})
			if err != nil {
				errs <- err
				return
			}
			ids <- task.ID
		}()
	}
	wg.Wait()
	close(errs)
	close(ids)
	for err := range errs {
		t.Error(err)
	}
	first := ""
	for tid := range ids {
		if first == "" {
			first = tid
		}
		if first != tid {
			t.Fatal("duplicate task")
		}
	}
	var taskCount int64
	if err := db.Model(&model.Task{}).Count(&taskCount).Error; err != nil || taskCount != 1 {
		t.Fatalf("expected one local task, got %d: %v", taskCount, err)
	}
	if task, err := s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID}); err != nil || task.ID != first {
		t.Fatalf("consumed replay: %v %v", task, err)
	}
	db.Model(&model.Task{}).Where("id = ?", first).Update("status", model.TaskStatusFailed)
	if _, err := s.RetryTask("user", first); err == nil {
		t.Fatal("legacy retry bypass accepted")
	}
}

func TestCreationCanvasScopeAndStableCreate(t *testing.T) {
	s, _, id, guard := creationTestService(t)
	ops := []CreationCanvasOp{{Type: "add_node", ID: "node", NodeType: "text", Title: "计划", Position: map[string]any{"x": float64(0), "y": float64(0)}, Metadata: map[string]any{"content": "已批准"}}}
	if _, err := s.ChangeCreationRun("user", id, "proposal-approve", CreationRequest{CreationGuard: guard, Revision: 2, ProposalVersion: 1, Proposal: json.RawMessage(`{"title":"计划"}`), Ops: ops}); err != nil {
		t.Fatal(err)
	}
	one, err := s.CreateRunCanvas("user", id, CreationRequest{CreationGuard: guard})
	if err != nil {
		t.Fatal(err)
	}
	two, err := s.CreateRunCanvas("user", id, CreationRequest{CreationGuard: guard})
	if err != nil || one["canvasId"] != two["canvasId"] {
		t.Fatal("canvas creation not stable")
	}
	snapshot, err := s.CreationCanvasSnapshot("user", id)
	if err != nil {
		t.Fatal(err)
	}
	doc := snapshot["document"].(map[string]any)
	doc["nodes"] = []any{creationAddedNode(ops[0])}
	raw, _ := json.Marshal(doc)
	if _, err = s.CommitCreationCanvas("user", id, CreationRequest{CreationGuard: guard, ExpectedSnapshotHash: snapshot["snapshotHash"].(string), Document: raw}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CommitCreationCanvas("user", id, CreationRequest{CreationGuard: guard, ExpectedSnapshotHash: snapshot["snapshotHash"].(string), Document: raw}); err == nil {
		t.Fatal("stale canvas hash accepted")
	}
	snapshot, _ = s.CreationCanvasSnapshot("user", id)
	doc = snapshot["document"].(map[string]any)
	doc["title"] = "unauthorized"
	raw, _ = json.Marshal(doc)
	if _, err = s.CommitCreationCanvas("user", id, CreationRequest{CreationGuard: guard, ExpectedSnapshotHash: snapshot["snapshotHash"].(string), Document: raw}); err == nil {
		t.Fatal("out-of-scope document accepted")
	}
}

func TestCreationResultWritesOnlyBoundResources(t *testing.T) {
	s, db, id, _ := creationTestService(t)
	sid := "sub-result"
	taskID := "task-result"
	request := creationTextRequest()
	request.Input["nodeId"] = "image-node"
	raw, _ := json.Marshal(request)
	for _, item := range []any{&model.Resource{ID: "output", UserID: "user", Status: model.ResourceStatusReady, Kind: "media", MimeType: "image/png", Size: 123, Width: 720, Height: 1280}, &model.Asset{ID: "asset-output", UserID: "user", Kind: "image", PayloadJSON: `{"storageKey":"resource:output"}`}, &model.Task{ID: taskID, UserID: "user", CreationSubmissionID: &sid, Status: model.TaskStatusSucceeded, ResultJSON: `{"images":[{"storageKey":"resource:output","url":"/api/resources/output/file"}]}`}, &model.CreationSubmission{ID: sid, UserID: "user", RunID: id, ItemKey: "result", RequestJSON: string(raw), TaskID: &taskID}} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	before := map[string]any{"prompt": "保留手工提示词"}
	after := mergeCreationMaps(before, map[string]any{"content": "/api/resources/output/file", "storageKey": "resource:output", "assetId": "asset-output", "generationTaskId": taskID, "status": "success", "naturalWidth": float64(720)})
	if err := validateCreationResultMetadata(s.repo, "user", id, "image-node", before, after); err != nil {
		t.Fatal(err)
	}
	after["prompt"] = "覆盖"
	if err := validateCreationResultMetadata(s.repo, "user", id, "image-node", before, after); err == nil {
		t.Fatal("result changed manual prompt")
	}
	after["prompt"] = before["prompt"]
	after["storageKey"] = "resource:other"
	if err := validateCreationResultMetadata(s.repo, "user", id, "image-node", before, after); err == nil {
		t.Fatal("unbound resource accepted")
	}
}

func TestCreationApprovedUpdateDoesNotOverwriteLaterManualEdit(t *testing.T) {
	before := map[string]any{"id": "canvas", "nodes": []any{map[string]any{"id": "n", "type": "text", "title": "before", "metadata": map[string]any{"content": "original"}}}, "connections": []any{}}
	ops := []CreationCanvasOp{{Type: "update_node", ID: "n", Metadata: map[string]any{"content": "approved"}}}
	raw, _ := json.Marshal(before)
	baseline, err := creationApprovalBaseline(string(raw), ops)
	if err != nil {
		t.Fatal(err)
	}
	run := &model.CreationRun{ApprovedCanvasJSON: baseline}
	nodes := before["nodes"].([]any)
	nodes[0].(map[string]any)["metadata"] = map[string]any{"content": "later manual edit"}
	afterRaw, _ := json.Marshal(before)
	var after map[string]any
	_ = json.Unmarshal(afterRaw, &after)
	after["nodes"].([]any)[0].(map[string]any)["metadata"] = map[string]any{"content": "approved"}
	if err := validateCreationCanvasDiff(nil, "user", run, before, after, ops); err == nil {
		t.Fatal("approved operation overwrote later manual edit")
	}
}

func TestCreationMediaScopeRejectsChangedModelSpecAndReferences(t *testing.T) {
	now := time.Now()
	ops := []CreationCanvasOp{{Type: "add_node", ID: "v", NodeType: "video", Metadata: map[string]any{"prompt": "短片", "model": "managed-video", "size": "9:16", "seconds": "15", "referenceNodeIds": []any{"ref"}}}}
	b, _ := json.Marshal(ops)
	run := &model.CreationRun{CanvasID: "canvas", Status: "running", ApprovedProposalVersion: 1, ApprovedProposalHash: "hash", ApprovedOperationsJSON: string(b), ApprovedAt: &now}
	request := CreateTaskRequest{Type: "canvas_video", ProjectID: "canvas", Prompt: "短片", Model: "managed-video", Input: map[string]any{"nodeId": "v", "config": map[string]any{"size": "9:16", "videoSeconds": "15"}, "referenceImages": []any{map[string]any{"id": "ref"}}}}
	if err := validateCreationSubmissionScope(run, 1, request); err != nil {
		t.Fatal(err)
	}
	request.Input["config"].(map[string]any)["videoSeconds"] = "5"
	if err := validateCreationSubmissionScope(run, 1, request); err == nil {
		t.Fatal("duration silently changed")
	}
	request.Input["config"].(map[string]any)["videoSeconds"] = "15"
	request.Model = "other"
	if err := validateCreationSubmissionScope(run, 1, request); err == nil {
		t.Fatal("model changed")
	}
	request.Model = "managed-video"
	request.Input["referenceImages"] = []any{map[string]any{"id": "other"}}
	if err := validateCreationSubmissionScope(run, 1, request); err == nil {
		t.Fatal("reference changed")
	}
}
