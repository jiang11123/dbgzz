package assistantturns_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type testCanvasFactory struct {
	base *canvas.Service
}

func (f testCanvasFactory) BoundTo(tx *gorm.DB) assistantturns.CanvasSession {
	svc := f.base
	if tx != nil {
		svc = f.base.WithRepository(repository.New(tx))
	}
	return testCanvasSession{svc: svc}
}

type testCanvasSession struct{ svc *canvas.Service }

func (s testCanvasSession) UserCanvasProject(userID, canvasID string) (json.RawMessage, error) {
	return s.svc.UserCanvasProject(userID, canvasID)
}

func (s testCanvasSession) UpsertUserCanvasProject(userID string, raw json.RawMessage) (int64, error) {
	summary, err := s.svc.UpsertUserCanvasProject(userID, raw)
	if err != nil {
		return 0, err
	}
	return summary.Revision, nil
}

type turnFixture struct {
	db       *gorm.DB
	path     string
	dir      string
	repo     *repository.Repository
	canvas   *canvas.Service
	turns    *assistantturns.Service
	userID   string
	canvasID string
}

func openTurnFixture(t *testing.T) *turnFixture {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "workspace.db")
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "local", Name: "本地工作区"}).Error; err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	canv := canvas.New(repo, nil)
	turns := assistantturns.New(assistantturns.NewStore(repo), testCanvasFactory{base: canv}, filepath.Join(dir, "assistant-turns"))
	fx := &turnFixture{db: db, path: path, dir: dir, repo: repo, canvas: canv, turns: turns, userID: "local", canvasID: "canvas-1"}
	fx.writeCanvas(t, map[string]any{
		"id": fx.canvasID, "title": "回合", "revision": 0,
		"nodes":       []any{map[string]any{"id": "n1", "type": "text", "title": "原节点", "position": map[string]any{"x": 0, "y": 0}}},
		"connections": []any{},
	})
	return fx
}

func (fx *turnFixture) writeCanvas(t *testing.T, doc map[string]any) int64 {
	t.Helper()
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := fx.canvas.UpsertUserCanvasProject(fx.userID, raw)
	if err != nil {
		t.Fatal(err)
	}
	return summary.Revision
}

func (fx *turnFixture) readCanvas(t *testing.T) map[string]any {
	t.Helper()
	raw, err := fx.canvas.UserCanvasProject(fx.userID, fx.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func (fx *turnFixture) revision(t *testing.T) int64 {
	t.Helper()
	return assistantturns.DocumentRevision(fx.readCanvas(t))
}

func (fx *turnFixture) appendNode(t *testing.T, nodeID string) int64 {
	t.Helper()
	doc := fx.readCanvas(t)
	nodes, _ := doc["nodes"].([]any)
	doc["nodes"] = append(nodes, map[string]any{"id": nodeID, "type": "text", "title": nodeID, "position": map[string]any{"x": 10, "y": 10}})
	return fx.writeCanvas(t, doc)
}

func (fx *turnFixture) receipt(t *testing.T, turnID, opID, op string, payload map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := fx.db.Create(&model.AgentOpRecord{UserID: fx.userID, OpID: opID, Op: op, Status: "succeeded", ResultJSON: string(encoded), TurnID: turnID}).Error; err != nil {
		t.Fatal(err)
	}
}

func (fx *turnFixture) reopen(t *testing.T) *turnFixture {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(fx.path), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	repo := repository.New(db)
	canv := canvas.New(repo, nil)
	turns := assistantturns.New(assistantturns.NewStore(repo), testCanvasFactory{base: canv}, filepath.Join(fx.dir, "assistant-turns"))
	return &turnFixture{db: db, path: fx.path, dir: fx.dir, repo: repo, canvas: canv, turns: turns, userID: fx.userID, canvasID: fx.canvasID}
}

func TestBeginReplaySameIDKeepsSnapshot(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223344"
	before, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{AssetIDs: []string{"a1"}})
	if err != nil {
		t.Fatal(err)
	}
	fx.appendNode(t, "n2")
	again, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{AssetIDs: []string{"a1"}})
	if err != nil {
		t.Fatal(err)
	}
	if again != before {
		t.Fatalf("replay overwrote snapshot revision: %d -> %d", before, again)
	}
	rec, err := fx.turns.Load(turnID)
	if err != nil {
		t.Fatal(err)
	}
	if rec.RevisionBefore != before || rec.State != assistantturns.StateOpen {
		t.Fatalf("snapshot mutated: %+v", rec)
	}
}

func TestBeginSameIDDifferentScopeRejected(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223345"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{AssetIDs: []string{"a1"}}); err != nil {
		t.Fatal(err)
	}
	_, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{AssetIDs: []string{"a2"}})
	var turnErr *assistantturns.Error
	if !errors.As(err, &turnErr) || turnErr.Reason != assistantturns.ReasonIDCollision {
		t.Fatalf("expected collision, got %v", err)
	}
}

func TestBeginRequiresActorIdentity(t *testing.T) {
	fx := openTurnFixture(t)
	if _, err := fx.turns.Begin("", fx.canvasID, "aabbccdd11223346", assistantturns.Input{}); err == nil {
		t.Fatal("empty user must fail")
	}
	if _, err := fx.turns.Begin(fx.userID, "", "aabbccdd11223346", assistantturns.Input{}); err == nil {
		t.Fatal("empty canvas must fail")
	}
}

func TestForeignOwnerCannotUndoOrReadScope(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223347"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	after := fx.appendNode(t, "n2")
	fx.receipt(t, turnID, "op-n2", "canvas.nodes.create", map[string]any{"canvasId": fx.canvasID, "revision": after, "created": []any{map[string]any{"id": "n2"}}})
	if _, ok, err := fx.turns.ScopeForHost("other", turnID); err != nil || ok {
		t.Fatalf("foreign scope leaked: ok=%v err=%v", ok, err)
	}
	if _, err := fx.turns.Undo("other", fx.canvasID, turnID); err == nil {
		t.Fatal("foreign undo must fail")
	}
	if fx.turns.Undone("other", fx.canvasID, turnID) {
		t.Fatal("foreign undone leaked")
	}
}

func TestStaleClosedScopeRejected(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223348"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := fx.turns.ScopeForHost(fx.userID, turnID); err != nil || !ok {
		t.Fatalf("open scope missing: %v", err)
	}
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := fx.turns.ScopeForHost(fx.userID, turnID); ok {
		t.Fatal("settled turn still open for host")
	}
	if err := fx.db.Transaction(func(tx *gorm.DB) error {
		return fx.turns.VerifyOpenTurnInTx(tx, fx.userID, turnID, fx.canvasID)
	}); err == nil {
		t.Fatal("verify after settle must fail")
	}
}

func TestHistoryCountsRepeatedEditsOnceAndRetainsEveryReceipt(t *testing.T) {
	fx := openTurnFixture(t)
	fx.appendNode(t, "edited-video")
	turnID := "aabbccdd11223399"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	for _, title := range []string{"first-edit", "second-edit"} {
		doc := fx.readCanvas(t)
		for _, raw := range doc["nodes"].([]any) {
			node := raw.(map[string]any)
			if node["id"] == "edited-video" {
				node["title"] = title
			}
		}
		revision := fx.writeCanvas(t, doc)
		fx.receipt(t, turnID, title, "canvas.node.update", map[string]any{
			"canvasId": fx.canvasID, "revision": revision, "nodeId": "edited-video",
		})
	}
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	reopened := fx.reopen(t)
	history, err := reopened.turns.History(fx.userID, fx.canvasID, turnID)
	if err != nil || history == nil || history.Change == nil {
		t.Fatalf("history missing: %+v %v", history, err)
	}
	if !reflect.DeepEqual(history.Change.UpdatedNodeIDs, []string{"edited-video"}) ||
		!reflect.DeepEqual(history.Change.OperationIDs, []string{"first-edit", "second-edit"}) {
		t.Fatalf("history must count objects without losing write receipts: %+v", history.Change)
	}
}

func TestTaskBindingHistoryAndUndoRetainOriginalReceiptOwnership(t *testing.T) {
	fx := openTurnFixture(t)
	fx.appendNode(t, "bound-image")
	before := fx.readCanvas(t)
	turnID := "aabbccdd11223400"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	after := fx.readCanvas(t)
	for _, raw := range after["nodes"].([]any) {
		node := raw.(map[string]any)
		if node["id"] == "bound-image" {
			node["metadata"] = map[string]any{"content": "resource:ready", "status": "success"}
		}
	}
	revision := fx.writeCanvas(t, after)
	fx.receipt(t, turnID, "attach-node:task:bound-image:0", "canvas.task.bind", map[string]any{
		"canvasId": fx.canvasID, "revision": revision, "nodeId": "bound-image", "applied": true,
	})
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	reopened := fx.reopen(t)
	history, err := reopened.turns.History(fx.userID, fx.canvasID, turnID)
	if err != nil || history == nil || history.Change == nil || !reflect.DeepEqual(history.Change.UpdatedNodeIDs, []string{"bound-image"}) {
		t.Fatalf("binding update missing from durable history: %+v %v", history, err)
	}
	// A replay belongs to the original operation's turn; it must not make a later read-only turn undoable.
	replayTurn := "aabbccdd11223401"
	if _, err := reopened.turns.Begin(fx.userID, fx.canvasID, replayTurn, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	if err := reopened.turns.Finalize(replayTurn); err != nil {
		t.Fatal(err)
	}
	replay, err := reopened.turns.History(fx.userID, fx.canvasID, replayTurn)
	if err != nil || replay == nil || replay.Change != nil {
		t.Fatalf("prior binding must not become a later turn's change: %+v %v", replay, err)
	}
	if _, err := reopened.turns.Undo(fx.userID, fx.canvasID, turnID); err != nil {
		t.Fatal(err)
	}
	if restored := reopened.readCanvas(t); !reflect.DeepEqual(restored["nodes"], before["nodes"]) {
		t.Fatalf("binding undo did not restore original nodes: %+v", restored["nodes"])
	}
}

func TestInterruptedFinalizeKeepsOpenSnapshot(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223349"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	if err := fx.db.Create(&model.AgentOpRecord{UserID: fx.userID, OpID: "bad", Op: "canvas.node.update", Status: "succeeded", ResultJSON: "{invalid", TurnID: turnID}).Error; err != nil {
		t.Fatal(err)
	}
	if err := fx.turns.Finalize(turnID); err == nil {
		t.Fatal("corrupt receipt must fail finalize")
	}
	rec, err := fx.turns.Load(turnID)
	if err != nil || rec.State != assistantturns.StateOpen || len(rec.Document) == 0 {
		t.Fatalf("snapshot lost: %+v %v", rec, err)
	}
}

func (fx *turnFixture) writeLegacyBytes(t *testing.T, turnID string, raw []byte) string {
	t.Helper()
	dir := filepath.Join(fx.dir, "assistant-turns")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, turnID+".json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func (fx *turnFixture) mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func (fx *turnFixture) assertNoLegacyFiles(t *testing.T) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(fx.dir, "assistant-turns", "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("production path wrote legacy files: %v", matches)
	}
}

func (fx *turnFixture) rowCount(t *testing.T, turnID string) int64 {
	t.Helper()
	var count int64
	if err := fx.db.Model(&model.AssistantTurn{}).Where("turn_id = ?", turnID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count
}

func TestFailedUndoMarkerRollsBackCanvas(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122334a"
	before, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{})
	if err != nil {
		t.Fatal(err)
	}
	after := fx.appendNode(t, "n2")
	fx.receipt(t, turnID, "op-n2", "canvas.nodes.create", map[string]any{"canvasId": fx.canvasID, "revision": after, "created": []any{map[string]any{"id": "n2"}}})
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	injected := errors.New("injected marker failure")
	_, err = fx.turns.WithUndoMarkerHook(func() error { return injected }).Undo(fx.userID, fx.canvasID, turnID)
	if !errors.Is(err, injected) {
		t.Fatalf("got %v", err)
	}
	if fx.revision(t) != after {
		t.Fatalf("canvas restore survived marker failure: %d (before %d after %d)", fx.revision(t), before, after)
	}
	if fx.turns.Undone(fx.userID, fx.canvasID, turnID) {
		t.Fatal("undone marker committed after rollback")
	}
	nodes, _ := fx.readCanvas(t)["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("node set changed: %v", nodes)
	}
	fx.assertNoLegacyFiles(t)
}

func TestLaterEditsNotLostOnUndo(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122334b"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	after := fx.appendNode(t, "n2")
	fx.receipt(t, turnID, "op-n2", "canvas.nodes.create", map[string]any{"canvasId": fx.canvasID, "revision": after, "created": []any{map[string]any{"id": "n2"}}})
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	fx.appendNode(t, "n3")
	_, err := fx.turns.Undo(fx.userID, fx.canvasID, turnID)
	var turnErr *assistantturns.Error
	if !errors.As(err, &turnErr) || turnErr.Reason != assistantturns.ReasonCanvasChanged {
		t.Fatalf("got %v", err)
	}
	nodes, _ := fx.readCanvas(t)["nodes"].([]any)
	if len(nodes) != 3 {
		t.Fatalf("later edit lost: %v", nodes)
	}
}

func TestReopenReadsDurableState(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122334c"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	after := fx.appendNode(t, "n2")
	fx.receipt(t, turnID, "op-n2", "canvas.nodes.create", map[string]any{"canvasId": fx.canvasID, "revision": after, "created": []any{map[string]any{"id": "n2"}}})
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.turns.Undo(fx.userID, fx.canvasID, turnID); err != nil {
		t.Fatal(err)
	}
	reopened := fx.reopen(t)
	if !reopened.turns.Undone(fx.userID, fx.canvasID, turnID) {
		t.Fatal("undo marker missing after reopen")
	}
	if _, ok, _ := reopened.turns.ScopeForHost(fx.userID, turnID); ok {
		t.Fatal("undone turn still open after reopen")
	}
}

func TestLegacyJSONImportIsIdempotent(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122334d"
	doc, err := json.Marshal(fx.readCanvas(t))
	if err != nil {
		t.Fatal(err)
	}
	legacy := map[string]any{
		"turnId": turnID, "userId": fx.userID, "canvasId": fx.canvasID,
		"revisionBefore": 0, "createdAt": "2026-01-02T03:04:05.000000000Z",
		"state": "open", "selectedNodeIds": []string{"n1"},
		"referencedAssetIds": []string{"asset-1"}, "undone": false,
		"document": json.RawMessage(doc),
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(fx.dir, "assistant-turns")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, turnID+".json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	scope, ok, err := fx.turns.ScopeForHost(fx.userID, turnID)
	if err != nil || !ok || scope.CanvasID != fx.canvasID {
		t.Fatalf("import failed: %+v %v %v", scope, ok, err)
	}
	if !contains(scope.AssetIDs, "asset-1") {
		t.Fatalf("imported assets: %v", scope.AssetIDs)
	}
	scope2, ok, err := fx.turns.ScopeForHost(fx.userID, turnID)
	if err != nil || !ok || scope2.CanvasID != scope.CanvasID {
		t.Fatalf("reimport changed record: %+v %v", scope2, err)
	}
	if _, err := os.Stat(filepath.Join(dir, turnID+".json")); err != nil {
		t.Fatal("legacy file was deleted")
	}
}

func TestCorruptLegacyFileIsObservable(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122334e"
	dir := filepath.Join(fx.dir, "assistant-turns")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, turnID+".json"), []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := fx.turns.ScopeForHost(fx.userID, turnID)
	var turnErr *assistantturns.Error
	if !errors.As(err, &turnErr) || turnErr.Reason != assistantturns.ReasonCorruptFile {
		t.Fatalf("corrupt file hidden: %v", err)
	}
}

func TestOwnershipMismatchOnLegacyFileIsObservable(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122334f"
	raw, _ := json.Marshal(map[string]any{
		"turnId": "aaaaaaaaaaaaaaaa", "userId": fx.userID, "canvasId": fx.canvasID,
		"revisionBefore": 0, "state": "open", "document": map[string]any{"id": fx.canvasID},
	})
	dir := filepath.Join(fx.dir, "assistant-turns")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, turnID+".json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := fx.turns.ScopeForHost(fx.userID, turnID)
	var turnErr *assistantturns.Error
	if !errors.As(err, &turnErr) || turnErr.Reason != assistantturns.ReasonOwnership {
		t.Fatalf("ownership mismatch hidden: %v", err)
	}
}

func TestSimultaneousUnrelatedWorkspacesHaveNoGlobalLock(t *testing.T) {
	left := openTurnFixture(t)
	right := openTurnFixture(t)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, err := left.turns.Begin(left.userID, left.canvasID, "aaaaaaaaaaaaaaaa", assistantturns.Input{})
		errs <- err
	}()
	go func() {
		defer wg.Done()
		_, err := right.turns.Begin(right.userID, right.canvasID, "bbbbbbbbbbbbbbbb", assistantturns.Input{})
		errs <- err
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, ok, _ := left.turns.ScopeForHost(left.userID, "aaaaaaaaaaaaaaaa"); !ok {
		t.Fatal("left turn missing")
	}
	if _, ok, _ := right.turns.ScopeForHost(right.userID, "bbbbbbbbbbbbbbbb"); !ok {
		t.Fatal("right turn missing")
	}
}

func TestRetentionSkipsOpenTurns(t *testing.T) {
	fx := openTurnFixture(t)
	openID := "ffffffffffffffff"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, openID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 70; i++ {
		id := hexID(i)
		if _, err := fx.turns.Begin(fx.userID, fx.canvasID, id, assistantturns.Input{}); err != nil {
			t.Fatal(err)
		}
		if err := fx.turns.Finalize(id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, "eeeeeeeeeeeeeeee", assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	rec, err := fx.turns.Load(openID)
	if err != nil || rec.State != assistantturns.StateOpen {
		t.Fatalf("open turn pruned: %+v %v", rec, err)
	}
}

func TestBeginDoesNotWriteLegacyFile(t *testing.T) {
	fx := openTurnFixture(t)
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, "aabbccdd11223360", assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	fx.assertNoLegacyFiles(t)
}

func TestBeginLegacySameIDReplaysOriginalSnapshot(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223361"
	legacyDoc, err := json.Marshal(map[string]any{"id": fx.canvasID, "revision": 7, "nodes": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{
		"turnId": turnID, "userId": fx.userID, "canvasId": fx.canvasID,
		"revisionBefore": 7, "createdAt": "2026-01-02T03:04:05.000000000Z",
		"state": "open", "referencedAssetIds": []string{"a1"}, "undone": false,
		"document": json.RawMessage(legacyDoc),
	})
	if err != nil {
		t.Fatal(err)
	}
	path := fx.writeLegacyBytes(t, turnID, body)
	before := fx.mustReadFile(t, path)
	fx.appendNode(t, "n2")
	got, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{AssetIDs: []string{"a1"}})
	if err != nil {
		t.Fatal(err)
	}
	if got != 7 {
		t.Fatalf("legacy replay used current canvas: %d", got)
	}
	if !bytes.Equal(before, fx.mustReadFile(t, path)) {
		t.Fatal("legacy source file was modified")
	}
	rec, err := fx.turns.Load(turnID)
	if err != nil {
		t.Fatal(err)
	}
	if rec.RevisionBefore != 7 || !bytes.Equal(rec.Document, legacyDoc) {
		t.Fatalf("imported snapshot replaced: %+v", rec)
	}
}

func TestBeginLegacySameIDCollisionPreservesFile(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223362"
	body, err := json.Marshal(map[string]any{
		"turnId": turnID, "userId": fx.userID, "canvasId": fx.canvasID,
		"revisionBefore": 3, "createdAt": "2026-01-02T03:04:05.000000000Z",
		"state": "open", "referencedAssetIds": []string{"a1"}, "undone": false,
		"document": map[string]any{"id": fx.canvasID, "revision": 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	path := fx.writeLegacyBytes(t, turnID, body)
	before := fx.mustReadFile(t, path)
	_, err = fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{AssetIDs: []string{"a2"}})
	var turnErr *assistantturns.Error
	if !errors.As(err, &turnErr) || turnErr.Reason != assistantturns.ReasonIDCollision {
		t.Fatalf("expected collision, got %v", err)
	}
	if !bytes.Equal(before, fx.mustReadFile(t, path)) {
		t.Fatal("collision mutated legacy source file")
	}
	if fx.rowCount(t, turnID) != 0 {
		t.Fatal("mismatch begin imported a replacement row")
	}
}

func TestBeginCorruptLegacyPreservesFile(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223363"
	path := fx.writeLegacyBytes(t, turnID, []byte("{nope"))
	before := fx.mustReadFile(t, path)
	_, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{})
	var turnErr *assistantturns.Error
	if !errors.As(err, &turnErr) || turnErr.Reason != assistantturns.ReasonCorruptFile {
		t.Fatalf("corrupt legacy hidden: %v", err)
	}
	if !bytes.Equal(before, fx.mustReadFile(t, path)) {
		t.Fatal("corrupt begin mutated source file")
	}
	if fx.rowCount(t, turnID) != 0 {
		t.Fatal("corrupt begin inserted a replacement row")
	}
}

func TestRetentionCompactsSnapshotsWithoutResurrectingLegacy(t *testing.T) {
	fx := openTurnFixture(t)
	openID := "ffffffffffffffff"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, openID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	overflowID := hexID(69)
	legacyBody, err := json.Marshal(map[string]any{
		"turnId": overflowID, "userId": fx.userID, "canvasId": fx.canvasID,
		"revisionBefore": 1, "createdAt": "2026-01-02T03:04:05.000000000Z",
		"state": "open", "referencedAssetIds": []string{"resurrect"}, "undone": false,
		"document": map[string]any{"id": fx.canvasID, "revision": 99, "title": "stale-open"},
	})
	if err != nil {
		t.Fatal(err)
	}
	legacyPath := fx.writeLegacyBytes(t, overflowID, legacyBody)
	legacyBefore := fx.mustReadFile(t, legacyPath)
	for i := 0; i < 70; i++ {
		id := hexID(i)
		row := model.AssistantTurn{
			TurnID:         id,
			UserID:         fx.userID,
			CanvasID:       fx.canvasID,
			RevisionBefore: 1,
			CreatedAt:      now.Add(-time.Duration(i) * time.Minute),
			UpdatedAt:      now,
			State:          assistantturns.StateSettled,
			Document:       `{"id":"canvas-1","revision":1}`,
		}
		if err := fx.db.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
	receiptID := "dddddddddddddddd"
	if err := fx.db.Create(&model.AssistantTurn{
		TurnID:         receiptID,
		UserID:         fx.userID,
		CanvasID:       fx.canvasID,
		RevisionBefore: 2,
		CreatedAt:      now.Add(-2 * time.Hour),
		UpdatedAt:      now,
		State:          assistantturns.StateSettled,
		Document:       `{"id":"canvas-1","revision":2,"keep":true}`,
		ChangeJSON:     `{"revisionBefore":2,"revisionAfter":3}`,
	}).Error; err != nil {
		t.Fatal(err)
	}
	fx.receipt(t, receiptID, "op-keep", "canvas.nodes.create", map[string]any{"canvasId": fx.canvasID, "revision": 3, "created": []any{map[string]any{"id": "kept"}}})
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, "eeeeeeeeeeeeeeee", assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}

	openRec, err := fx.turns.Load(openID)
	if err != nil || openRec.State != assistantturns.StateOpen || len(openRec.Document) == 0 {
		t.Fatalf("open turn compacted: %+v %v", openRec, err)
	}
	if fx.rowCount(t, overflowID) != 1 {
		t.Fatal("overflow identity row was deleted")
	}
	compacted, err := fx.turns.Load(overflowID)
	if err != nil {
		t.Fatal(err)
	}
	if compacted.State != assistantturns.StateSettled || len(compacted.Document) != 0 {
		t.Fatalf("overflow snapshot not compacted: %+v", compacted)
	}
	if !bytes.Equal(legacyBefore, fx.mustReadFile(t, legacyPath)) {
		t.Fatal("prune mutated legacy source file")
	}
	if _, ok, scopeErr := fx.turns.ScopeForHost(fx.userID, overflowID); scopeErr != nil || ok {
		t.Fatalf("tombstone resurrected open scope: ok=%v err=%v", ok, scopeErr)
	}
	_, beginErr := fx.turns.Begin(fx.userID, fx.canvasID, overflowID, assistantturns.Input{AssetIDs: []string{"resurrect"}})
	var turnErr *assistantturns.Error
	if !errors.As(beginErr, &turnErr) || turnErr.Reason != assistantturns.ReasonIDCollision {
		t.Fatalf("begin after prune resurrected legacy scope: %v", beginErr)
	}
	if !bytes.Equal(legacyBefore, fx.mustReadFile(t, legacyPath)) {
		t.Fatal("begin after prune mutated legacy source file")
	}
	replay, err := fx.turns.Begin(fx.userID, fx.canvasID, overflowID, assistantturns.Input{})
	if err != nil || replay != 1 {
		t.Fatalf("tombstone replay lost revision: %d %v", replay, err)
	}
	afterReplay, err := fx.turns.Load(overflowID)
	if err != nil || len(afterReplay.Document) != 0 || afterReplay.State != assistantturns.StateSettled {
		t.Fatalf("begin after prune restored snapshot: %+v %v", afterReplay, err)
	}
	kept, err := fx.turns.Load(receiptID)
	if err != nil || !bytes.Contains(kept.Document, []byte(`"keep"`)) {
		t.Fatalf("receipt-referenced snapshot compacted: %+v %v", kept, err)
	}
	var receipts int64
	if err := fx.db.Model(&model.AgentOpRecord{}).Where("turn_id = ?", receiptID).Count(&receipts).Error; err != nil {
		t.Fatal(err)
	}
	if receipts != 1 {
		t.Fatalf("receipt history lost: %d", receipts)
	}
}

func TestCorruptStoredScopeJSONIsObservable(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223364"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{SelectedNodeIDs: []string{"n1"}}); err != nil {
		t.Fatal(err)
	}
	if err := fx.db.Model(&model.AssistantTurn{}).Where("turn_id = ?", turnID).Update("selected_node_ids", "{not-json").Error; err != nil {
		t.Fatal(err)
	}
	scope, ok, err := fx.turns.ScopeForHost(fx.userID, turnID)
	var turnErr *assistantturns.Error
	if !errors.As(err, &turnErr) || turnErr.Reason != assistantturns.ReasonCorruptFile || ok {
		t.Fatalf("corrupt scope hidden: scope=%+v ok=%v err=%v", scope, ok, err)
	}
}

func TestCorruptStoredChangeJSONDoesNotInventUndo(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223365"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	after := fx.appendNode(t, "n2")
	fx.receipt(t, turnID, "op-n2", "canvas.nodes.create", map[string]any{"canvasId": fx.canvasID, "revision": after, "created": []any{map[string]any{"id": "n2"}}})
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	if err := fx.db.Model(&model.AssistantTurn{}).Where("turn_id = ?", turnID).Update("change_json", "{broken").Error; err != nil {
		t.Fatal(err)
	}
	_, err := fx.turns.Undo(fx.userID, fx.canvasID, turnID)
	var turnErr *assistantturns.Error
	if !errors.As(err, &turnErr) || turnErr.Reason != assistantturns.ReasonCorruptFile {
		t.Fatalf("corrupt change reconstructed undo: %v", err)
	}
	if fx.revision(t) != after {
		t.Fatalf("corrupt undo mutated canvas: %d", fx.revision(t))
	}
	if _, histErr := fx.turns.History(fx.userID, fx.canvasID, turnID); histErr == nil {
		t.Fatal("history must surface corrupt change json")
	}
}

func TestVerifyOpenTurnInTxAllowsOpenRound(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd11223350"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	if err := fx.db.Transaction(func(tx *gorm.DB) error {
		return fx.turns.VerifyOpenTurnInTx(tx, fx.userID, turnID, fx.canvasID)
	}); err != nil {
		t.Fatal(err)
	}
}

func hexID(n int) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 16)
	for i := range out {
		out[i] = '0'
	}
	for i := 15; n > 0 && i >= 0; i-- {
		out[i] = digits[n%16]
		n /= 16
	}
	out[0] = 'c'
	return string(out)
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// Row binding receipts declare the output edges they rewired; undo restores the row and edges.
func TestStoryboardRowUpdateReceiptEdgesReconstructAndUndo(t *testing.T) {
	fx := openTurnFixture(t)
	doc := fx.readCanvas(t)
	at := map[string]any{"x": 0, "y": 0}
	doc["nodes"] = []any{
		map[string]any{"id": "script", "type": "script", "title": "分镜", "position": at, "metadata": map[string]any{"storyboard": map[string]any{"rows": []any{
			map[string]any{"id": "shot-1", "imageNodeId": "old"}, map[string]any{"id": "shot-2", "dialogue": "keep"}}}}},
		map[string]any{"id": "old", "type": "image", "title": "old", "position": at},
		map[string]any{"id": "new", "type": "image", "title": "new", "position": at},
	}
	doc["connections"] = []any{
		map[string]any{"id": "out-old", "fromNodeId": "script", "toNodeId": "old", "fromHandleId": "row:shot-1", "relation": "storyboard-output", "storyboardRowId": "shot-1"},
		map[string]any{"id": "keep", "fromNodeId": "old", "toNodeId": "new"},
	}
	fx.writeCanvas(t, doc)
	before := fx.readCanvas(t)
	turnID := "abcdabcd12345678"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{}); err != nil {
		t.Fatal(err)
	}
	doc = fx.readCanvas(t)
	script := doc["nodes"].([]any)[0].(map[string]any)
	script["metadata"].(map[string]any)["storyboard"].(map[string]any)["rows"].([]any)[0].(map[string]any)["imageNodeId"] = "new"
	doc["connections"] = []any{doc["connections"].([]any)[1],
		map[string]any{"id": "out-new", "fromNodeId": "script", "toNodeId": "new", "fromHandleId": "row:shot-1", "relation": "storyboard-output", "storyboardRowId": "shot-1"}}
	revision := fx.writeCanvas(t, doc)
	fx.receipt(t, turnID, "bind-row", "canvas.script.row.update", map[string]any{"canvasId": fx.canvasID, "nodeId": "script", "revision": revision,
		"createdEdgeIds": []string{"out-new"}, "deletedEdgeIds": []string{"out-old"}})
	if err := fx.turns.Finalize(turnID); err != nil {
		t.Fatal(err)
	}
	state, err := fx.turns.History(fx.userID, fx.canvasID, turnID)
	if err != nil || state == nil || state.Change == nil {
		t.Fatalf("history: %+v %v", state, err)
	}
	if !reflect.DeepEqual(state.Change.UpdatedNodeIDs, []string{"script"}) || !reflect.DeepEqual(state.Change.CreatedEdgeIDs, []string{"out-new"}) || !reflect.DeepEqual(state.Change.DeletedEdgeIDs, []string{"out-old"}) {
		t.Fatalf("change: %+v", state.Change)
	}
	if _, err := fx.turns.Undo(fx.userID, fx.canvasID, turnID); err != nil {
		t.Fatal(err)
	}
	restored := fx.readCanvas(t)
	if !reflect.DeepEqual(restored["nodes"], before["nodes"]) || !reflect.DeepEqual(restored["connections"], before["connections"]) {
		t.Fatalf("undo restore: %#v", restored)
	}
}
