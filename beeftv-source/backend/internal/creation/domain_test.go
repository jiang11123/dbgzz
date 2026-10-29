package creation

import (
	"encoding/json"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type testQuota struct {
	failCanvas bool
}

func (q *testQuota) ValidateRun(string, *repository.Repository, bool, int64) error {
	return nil
}
func (q *testQuota) ValidateCanvas(string, *repository.Repository, bool, int64) error {
	if q.failCanvas {
		return Conflict("injected canvas quota")
	}
	return nil
}

type testSecrets struct{}

func (testSecrets) Protect(map[string]any) error { return nil }

type testMedia struct{}

func (testMedia) ValidateDocument(string, *repository.Repository, json.RawMessage) error {
	return nil
}

type txMedia struct{}

func (txMedia) ValidateDocument(userID string, repo *repository.Repository, raw json.RawMessage) error {
	if repo == nil {
		return Conflict("media validation missing transaction repository")
	}
	return canvas.New(repo, nil).ValidateCanvasMediaAssets(userID, raw)
}

type recordingMedia struct {
	repo *repository.Repository
}

func (m *recordingMedia) ValidateDocument(_ string, repo *repository.Repository, _ json.RawMessage) error {
	m.repo = repo
	if repo == nil {
		return Conflict("media validation missing transaction repository")
	}
	return nil
}

type failingSecrets struct{}

func (failingSecrets) Protect(input map[string]any) error {
	input["bad"] = make(chan int)
	return nil
}

type testKinds struct{}

func (testKinds) UsesWorkflow(map[string]any) bool   { return false }
func (testKinds) UsesTextReplay(map[string]any) bool { return false }

type testTasks struct {
	repo      *repository.Repository
	prepareN  atomic.Int32
	admitN    atomic.Int32
	nilTask   bool
	failAdmit error
}

func (t *testTasks) Prepare(userID string, req TaskRequest) (*PreparedTask, error) {
	t.prepareN.Add(1)
	input := req.Input
	if input == nil {
		input = map[string]any{}
	}
	raw, _ := json.Marshal(input)
	task := &model.Task{
		ID: kernel.NewID(), UserID: userID, ProjectID: req.ProjectID, Type: req.Type,
		Status: model.TaskStatusQueued, Stage: "等待队列调度", Progress: 5,
		Prompt: req.Prompt, Model: req.Model, InputJSON: string(raw),
	}
	config, _ := input["config"].(map[string]any)
	return &PreparedTask{Task: task, Input: input, Config: config}, nil
}

func (t *testTasks) Admit(userID string, repo *repository.Repository, task *model.Task) (*model.Task, error) {
	t.admitN.Add(1)
	if t.failAdmit != nil {
		return nil, t.failAdmit
	}
	if t.nilTask {
		return nil, nil
	}
	if task.ID == "" {
		task.ID = kernel.NewID()
	}
	if err := repo.CreateTaskWithActiveLimit(task, 32); err != nil {
		return nil, err
	}
	return task, nil
}

type harness struct {
	svc   *Service
	repo  *repository.Repository
	db    *gorm.DB
	tasks *testTasks
	quota *testQuota
	clock time.Time
	user  string
	runID string
	guard Guard
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "creation.db")+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(database.LocalModels()...); err != nil {
		t.Fatal(err)
	}
	h := &harness{db: db, repo: repository.New(db), quota: &testQuota{}, user: "user", clock: time.Now()}
	h.tasks = &testTasks{repo: h.repo}
	h.svc = New(h.repo, Dependencies{
		Tasks: h.tasks, Secrets: testSecrets{}, Quota: h.quota, Media: testMedia{}, Kinds: testKinds{},
		Now: func() time.Time { return h.clock }, NewID: kernel.NewID,
	})
	if err = db.Create(&model.ModelChannel{ID: "channel", Scope: model.ChannelScopeSystem, Enabled: true, Name: "受控测试"}).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Create(&model.ChannelModel{ID: "cm", ChannelID: "channel", ModelKey: "text-test", Capability: "text", Protocol: model.ChannelInterfaceChatCompletion, CapabilityConfigJSON: `{"version":1,"text":{"references":{"maxImages":4}}}`, Enabled: true}).Error; err != nil {
		t.Fatal(err)
	}
	detail, err := h.svc.CreateRun(h.user, Command{ClientKey: "client", State: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	h.runID = detail.Run.ID
	if _, err = h.svc.Change(h.user, h.runID, "claim", Command{ExpectedEpoch: 0, Guard: Guard{Owner: "page"}}); err != nil {
		t.Fatal(err)
	}
	h.guard = Guard{ExecutionEpoch: 1, Owner: "page"}
	return h
}

func textTask() TaskRequest {
	return TaskRequest{Type: "canvas_text", Prompt: "只输出测试", Model: "text-test", Input: map[string]any{"mode": "text", "prompt": "只输出测试", "config": map[string]any{"channelId": "channel", "model": "text-test"}}}
}

func (h *harness) cmd() Command {
	return Command{Guard: h.guard}
}

func TestExpiredLeaseAndStaleProposalRejected(t *testing.T) {
	h := newHarness(t)
	h.clock = h.clock.Add(time.Minute)
	if _, err := h.svc.Change(h.user, h.runID, "heartbeat", h.cmd()); err == nil {
		t.Fatal("expired lease heartbeat accepted")
	}
	if _, err := h.svc.Prepare(h.user, h.runID, Command{Guard: h.guard, ItemKey: "text-1", Task: textTask()}); err == nil {
		t.Fatal("expired lease prepare accepted")
	}
	h.clock = time.Now()
	if _, err := h.svc.Change(h.user, h.runID, "claim", Command{ExpectedEpoch: 1, Guard: Guard{Owner: "page"}}); err != nil {
		t.Fatal(err)
	}
	h.guard = Guard{ExecutionEpoch: 2, Owner: "page"}
	run, err := h.repo.CreationRun(h.user, h.runID)
	if err != nil {
		t.Fatal(err)
	}
	ops := []CanvasOp{{Type: "add_node", ID: "node", NodeType: "text", Title: "计划", Position: map[string]any{"x": float64(0), "y": float64(0)}, Metadata: map[string]any{"content": "已批准"}}}
	if _, err = h.svc.Change(h.user, h.runID, "proposal-approve", Command{Guard: h.guard, Revision: run.Revision, ProposalVersion: 1, Proposal: json.RawMessage(`{"title":"计划"}`), Ops: ops}); err != nil {
		t.Fatal(err)
	}
	item, err := h.svc.Prepare(h.user, h.runID, Command{Guard: h.guard, ItemKey: "stale", ProposalVersion: 1, Task: textTask()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.svc.Approve(h.user, h.runID, Command{Guard: h.guard, SubmissionIDs: []string{item.ID}}); err != nil {
		t.Fatal(err)
	}
	run, _ = h.repo.CreationRun(h.user, h.runID)
	if _, err = h.svc.Change(h.user, h.runID, "proposal-approve", Command{Guard: h.guard, Revision: run.Revision, ProposalVersion: 2, Proposal: json.RawMessage(`{"title":"新计划"}`), Ops: ops}); err != nil {
		t.Fatal(err)
	}
	if _, err = h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID}); err == nil {
		t.Fatal("stale proposal execute accepted")
	}
}

func TestSubmitReceiptReplayDoesNotCreateSecondTask(t *testing.T) {
	h := newHarness(t)
	item, err := h.svc.Prepare(h.user, h.runID, Command{Guard: h.guard, ItemKey: "text-1", Task: textTask()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.svc.Approve(h.user, h.runID, Command{Guard: h.guard, SubmissionIDs: []string{item.ID}}); err != nil {
		t.Fatal(err)
	}
	first, err := h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID})
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID})
	if err != nil || second.ID != first.ID {
		t.Fatalf("replay created a new task: %v %v", second, err)
	}
	var count int64
	if err = h.db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("expected one task, got %d: %v", count, err)
	}
	if h.tasks.admitN.Load() != 1 {
		t.Fatalf("admit called %d times", h.tasks.admitN.Load())
	}
}

func TestConfirmScopeAndOwnerProtected(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Get("other", h.runID); err == nil {
		t.Fatal("cross-user read accepted")
	}
	if _, err := h.svc.Change(h.user, h.runID, "save", Command{Guard: h.guard, Revision: 1, Status: "running", State: map[string]any{}}); err == nil {
		t.Fatal("stale revision accepted")
	}
	if _, err := h.svc.Change(h.user, h.runID, "heartbeat", Command{Guard: Guard{ExecutionEpoch: 1, Owner: "other-page"}}); err == nil {
		t.Fatal("foreign owner renewed lease")
	}
	if _, err := h.svc.Change(h.user, h.runID, "claim", Command{ExpectedEpoch: 0, Guard: Guard{Owner: "new-page"}}); err == nil {
		t.Fatal("stale epoch claim accepted")
	}
	if _, err := h.svc.Change(h.user, h.runID, "claim", Command{ExpectedEpoch: 1, Guard: Guard{Owner: "new-page"}}); err == nil {
		t.Fatal("foreign owner stole a live lease")
	}
	if _, err := h.svc.Change(h.user, h.runID, "claim", Command{ExpectedEpoch: 1, Guard: Guard{Owner: "page"}}); err != nil {
		t.Fatal(err)
	}
	h.guard = Guard{ExecutionEpoch: 2, Owner: "page"}
	if _, err := h.svc.Change(h.user, h.runID, "heartbeat", h.cmd()); err != nil {
		t.Fatal(err)
	}
}

func TestCanvasCommitRollbackRetainsRevision(t *testing.T) {
	h := newHarness(t)
	run, err := h.repo.CreationRun(h.user, h.runID)
	if err != nil {
		t.Fatal(err)
	}
	ops := []CanvasOp{{Type: "add_node", ID: "node", NodeType: "text", Title: "计划", Position: map[string]any{"x": float64(0), "y": float64(0)}, Metadata: map[string]any{"content": "已批准"}}}
	if _, err = h.svc.Change(h.user, h.runID, "proposal-approve", Command{Guard: h.guard, Revision: run.Revision, ProposalVersion: 1, Proposal: json.RawMessage(`{"title":"计划"}`), Ops: ops}); err != nil {
		t.Fatal(err)
	}
	created, err := h.svc.CreateCanvas(h.user, h.runID, h.cmd())
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := h.svc.CanvasSnapshot(h.user, h.runID)
	if err != nil {
		t.Fatal(err)
	}
	doc := snapshot["document"].(map[string]any)
	doc["nodes"] = []any{AddedNode(ops[0])}
	raw, _ := json.Marshal(doc)
	if _, err = h.svc.CommitCanvas(h.user, h.runID, Command{Guard: h.guard, ExpectedSnapshotHash: snapshot["snapshotHash"].(string), Document: raw}); err != nil {
		t.Fatal(err)
	}
	before, err := h.repo.CanvasProjectForUser(h.user, created["canvasId"].(string))
	if err != nil {
		t.Fatal(err)
	}
	snapshot, _ = h.svc.CanvasSnapshot(h.user, h.runID)
	doc = snapshot["document"].(map[string]any)
	doc["updatedAt"] = time.Now().Format(time.RFC3339Nano)
	raw, _ = json.Marshal(doc)
	if err = h.db.Callback().Update().Before("gorm:update").Register("creation_canvas_force_failure", func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Name == "CanvasProject" {
			tx.AddError(Conflict("injected canvas write failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = h.svc.CommitCanvas(h.user, h.runID, Command{Guard: h.guard, ExpectedSnapshotHash: snapshot["snapshotHash"].(string), Document: raw}); err == nil {
		t.Fatal("failed commit accepted")
	}
	_ = h.db.Callback().Update().Remove("creation_canvas_force_failure")
	after, err := h.repo.CanvasProjectForUser(h.user, created["canvasId"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if after.PayloadJSON != before.PayloadJSON || after.Revision != before.Revision {
		t.Fatalf("canvas mutated after rollback: rev %d -> %d", before.Revision, after.Revision)
	}
}

func TestProposalConfirmationIsNotStateFlag(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Change(h.user, h.runID, "release", h.cmd()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.Change(h.user, h.runID, "claim", Command{ExpectedEpoch: 1, Guard: Guard{Owner: "assistant"}}); err != nil {
		t.Fatal(err)
	}
	h.guard = Guard{ExecutionEpoch: 2, Owner: "assistant"}
	run, err := h.repo.CreationRun(h.user, h.runID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.svc.Change(h.user, h.runID, "save", Command{Guard: h.guard, Revision: run.Revision, Status: "running", State: map[string]any{"approved": true}}); err != nil {
		t.Fatal(err)
	}
	run, err = h.repo.CreationRun(h.user, h.runID)
	if err != nil {
		t.Fatal(err)
	}
	if run.ApprovedAt != nil {
		t.Fatal("state write granted proposal confirmation")
	}
	if _, err = h.svc.CreateCanvas(h.user, h.runID, h.cmd()); err == nil {
		t.Fatal("untrusted state created canvas")
	}
}

func TestLiveLeaseRejectsForeignOwnerUntilExpiry(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Change(h.user, h.runID, "claim", Command{ExpectedEpoch: 1, Guard: Guard{Owner: "other-page"}}); err == nil {
		t.Fatal("foreign owner stole a live lease")
	}
	run, err := h.repo.CreationRun(h.user, h.runID)
	if err != nil {
		t.Fatal(err)
	}
	if run.ExecutionOwner != "page" || run.ExecutionEpoch != 1 {
		t.Fatalf("live lease mutated: owner=%q epoch=%d", run.ExecutionOwner, run.ExecutionEpoch)
	}
	if _, err = h.svc.Change(h.user, h.runID, "claim", Command{ExpectedEpoch: 1, Guard: Guard{Owner: "page"}}); err != nil {
		t.Fatal(err)
	}
	h.guard = Guard{ExecutionEpoch: 2, Owner: "page"}
	if _, err = h.svc.Change(h.user, h.runID, "release", h.cmd()); err != nil {
		t.Fatal(err)
	}
	if _, err = h.svc.Change(h.user, h.runID, "claim", Command{ExpectedEpoch: 2, Guard: Guard{Owner: "other-page"}}); err != nil {
		t.Fatal(err)
	}
	h2 := newHarness(t)
	h2.clock = h2.clock.Add(time.Minute)
	if _, err = h2.svc.Change(h2.user, h2.runID, "claim", Command{ExpectedEpoch: 1, Guard: Guard{Owner: "later-page"}}); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentOwnersCannotStealLiveLease(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Change(h.user, h.runID, "release", h.cmd()); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	owners := []string{"page-a", "page-b"}
	results := make(chan string, 2)
	errs := make(chan error, 2)
	for _, owner := range owners {
		wg.Add(1)
		go func(owner string) {
			defer wg.Done()
			_, err := h.svc.Change(h.user, h.runID, "claim", Command{ExpectedEpoch: 1, Guard: Guard{Owner: owner}})
			if err != nil {
				errs <- err
				return
			}
			results <- owner
		}(owner)
	}
	wg.Wait()
	close(results)
	close(errs)
	winner := ""
	for owner := range results {
		if winner != "" {
			t.Fatal("both owners claimed the same live lease")
		}
		winner = owner
	}
	if winner == "" {
		t.Fatal("neither owner claimed the released lease")
	}
	run, err := h.repo.CreationRun(h.user, h.runID)
	if err != nil {
		t.Fatal(err)
	}
	if run.ExecutionOwner != winner {
		t.Fatalf("lease owner %q != winner %q", run.ExecutionOwner, winner)
	}
	loser := "page-a"
	if winner == "page-a" {
		loser = "page-b"
	}
	if _, err = h.svc.Change(h.user, h.runID, "claim", Command{ExpectedEpoch: run.ExecutionEpoch, Guard: Guard{Owner: loser}}); err == nil {
		t.Fatal("loser stole the live lease after reading the run")
	}
}

func TestExecuteFailsClosedOnProtectedInputAndNilTask(t *testing.T) {
	h := newHarness(t)
	item, err := h.svc.Prepare(h.user, h.runID, Command{Guard: h.guard, ItemKey: "text-1", Task: textTask()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.svc.Approve(h.user, h.runID, Command{Guard: h.guard, SubmissionIDs: []string{item.ID}}); err != nil {
		t.Fatal(err)
	}
	h.svc.deps.Secrets = failingSecrets{}
	if _, err = h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID}); err == nil {
		t.Fatal("invalid protected input admitted")
	}
	assertNoTaskRow(t, h, item.ID)
	if h.tasks.admitN.Load() != 0 {
		t.Fatalf("admit ran on invalid input: %d", h.tasks.admitN.Load())
	}
	h.svc.deps.Secrets = testSecrets{}
	h.tasks.nilTask = true
	if _, err = h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID}); err == nil {
		t.Fatal("nil admit task persisted")
	}
	assertNoTaskRow(t, h, item.ID)
}

func TestExecuteCommitLossRestartsToOneRow(t *testing.T) {
	h := newHarness(t)
	item, err := h.svc.Prepare(h.user, h.runID, Command{Guard: h.guard, ItemKey: "text-1", Task: textTask()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.svc.Approve(h.user, h.runID, Command{Guard: h.guard, SubmissionIDs: []string{item.ID}}); err != nil {
		t.Fatal(err)
	}
	if err = h.db.Callback().Create().Before("gorm:create").Register("creation_force_task_failure", func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Name == "Task" {
			tx.AddError(Conflict("injected task write failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID}); err == nil {
		t.Fatal("injected failure not propagated")
	}
	assertNoTaskRow(t, h, item.ID)
	if err = h.db.Callback().Create().Remove("creation_force_task_failure"); err != nil {
		t.Fatal(err)
	}
	first, err := h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID})
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID})
	if err != nil || second.ID != first.ID {
		t.Fatalf("restart created a second task: %v %v", second, err)
	}
	var count int64
	if err = h.db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("expected one task, got %d: %v", count, err)
	}
}

func assertNoTaskRow(t *testing.T, h *harness, submissionID string) {
	t.Helper()
	var count int64
	if err := h.db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("expected no task row, got %d: %v", count, err)
	}
	var item model.CreationSubmission
	if err := h.db.First(&item, "id = ?", submissionID).Error; err != nil {
		t.Fatal(err)
	}
	if item.TaskID != nil {
		t.Fatal("failed execute bound a task id")
	}
}

func TestConcurrentExecuteCreatesOneTask(t *testing.T) {
	h := newHarness(t)
	item, err := h.svc.Prepare(h.user, h.runID, Command{Guard: h.guard, ItemKey: "text-1", Task: textTask()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.svc.Approve(h.user, h.runID, Command{Guard: h.guard, SubmissionIDs: []string{item.ID}}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			task, err := h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID})
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
	for id := range ids {
		if first == "" {
			first = id
		}
		if first != id {
			t.Fatal("duplicate task")
		}
	}
	var count int64
	if err = h.db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("expected one task, got %d: %v", count, err)
	}
}

func TestCommitCanvasMediaUsesTransactionRepository(t *testing.T) {
	h := newHarness(t)
	media := &recordingMedia{}
	h.svc.deps.Media = media
	canvasID, hash, raw := seedApprovedCanvas(t, h)
	if _, err := h.svc.CommitCanvas(h.user, h.runID, Command{Guard: h.guard, ExpectedSnapshotHash: hash, Document: raw}); err != nil {
		t.Fatal(err)
	}
	if media.repo == nil || media.repo == h.repo {
		t.Fatal("media validation used the root repository")
	}
	before, err := h.repo.CanvasProjectForUser(h.user, canvasID)
	if err != nil {
		t.Fatal(err)
	}
	h.svc.deps.Media = txMedia{}
	if err = h.db.Create(&model.Resource{ID: "res-1", UserID: h.user, Status: model.ResourceStatusReady, Kind: "media", MimeType: "image/png", Size: 12}).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.db.Create(&model.Asset{ID: "asset-1", UserID: h.user, Kind: "image", PayloadJSON: `{"storageKey":"resource:res-1"}`}).Error; err != nil {
		t.Fatal(err)
	}
	doc, err := parseDocument(before.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	doc["nodes"] = []any{map[string]any{"id": "img", "type": "image", "title": "图", "metadata": map[string]any{
		"assetId": "asset-1", "storageKey": "resource:res-1", "content": "/api/resources/res-1/file",
	}}}
	injected, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	before.PayloadJSON = string(injected)
	if err = h.db.Save(before).Error; err != nil {
		t.Fatal(err)
	}
	snapshot, err := h.svc.CanvasSnapshot(h.user, h.runID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.svc.CommitCanvas(h.user, h.runID, Command{Guard: h.guard, ExpectedSnapshotHash: snapshot["snapshotHash"].(string), Document: injected}); err != nil {
		t.Fatal(err)
	}
	if err = h.db.Delete(&model.Asset{}, "id = ?", "asset-1").Error; err != nil {
		t.Fatal(err)
	}
	snapshot, err = h.svc.CanvasSnapshot(h.user, h.runID)
	if err != nil {
		t.Fatal(err)
	}
	doc = snapshot["document"].(map[string]any)
	doc["updatedAt"] = time.Now().Format(time.RFC3339Nano)
	stale, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.svc.CommitCanvas(h.user, h.runID, Command{Guard: h.guard, ExpectedSnapshotHash: snapshot["snapshotHash"].(string), Document: stale}); err == nil {
		t.Fatal("commit accepted a document after its asset was deleted")
	}
	after, err := h.repo.CanvasProjectForUser(h.user, canvasID)
	if err != nil {
		t.Fatal(err)
	}
	if after.PayloadJSON != string(injected) {
		t.Fatal("failed media validation mutated canvas")
	}
}

func seedApprovedCanvas(t *testing.T, h *harness) (string, string, json.RawMessage) {
	t.Helper()
	run, err := h.repo.CreationRun(h.user, h.runID)
	if err != nil {
		t.Fatal(err)
	}
	ops := []CanvasOp{{Type: "add_node", ID: "node", NodeType: "text", Title: "计划", Position: map[string]any{"x": float64(0), "y": float64(0)}, Metadata: map[string]any{"content": "已批准"}}}
	if _, err = h.svc.Change(h.user, h.runID, "proposal-approve", Command{Guard: h.guard, Revision: run.Revision, ProposalVersion: 1, Proposal: json.RawMessage(`{"title":"计划"}`), Ops: ops}); err != nil {
		t.Fatal(err)
	}
	created, err := h.svc.CreateCanvas(h.user, h.runID, h.cmd())
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := h.svc.CanvasSnapshot(h.user, h.runID)
	if err != nil {
		t.Fatal(err)
	}
	doc := snapshot["document"].(map[string]any)
	doc["nodes"] = []any{AddedNode(ops[0])}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return created["canvasId"].(string), snapshot["snapshotHash"].(string), raw
}
