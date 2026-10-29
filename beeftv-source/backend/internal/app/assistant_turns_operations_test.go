package app_test

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// External test package exercises the real operation store without an app ->
// agentops import cycle. No fabricated successful operation records.
type turnOperations struct {
	s *app.Service
	r *agentops.Registry
}

func newTurnOperations(t *testing.T) *turnOperations {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "turn.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "local", Name: "local"}).Error; err != nil {
		t.Fatal(err)
	}
	s := app.NewLocal(repository.New(db), t.TempDir())
	if _, err := s.UpsertUserCanvasProject("local", json.RawMessage(`{"id":"c","title":"original","revision":0,"nodes":[{"id":"S","type":"text","title":"original"}],"connections":[]}`)); err != nil {
		t.Fatal(err)
	}
	r := agentops.NewRegistry(s, agentops.NewStore(db))
	agentops.RegisterDefaultOps(r)
	return &turnOperations{s, r}
}

func (h *turnOperations) document(t *testing.T) map[string]any {
	t.Helper()
	raw, err := h.s.UserCanvasProject("local", "c")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func (h *turnOperations) run(t *testing.T, op, id string, turnID string, params map[string]any) agentops.Result {
	t.Helper()
	params["canvasId"] = "c"
	params["expectedRevision"] = h.document(t)["revision"]
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	// 回合归属走真实入口：回执在业务写入的同一个事务里落库。
	result, err := h.r.Execute(agentops.Request{UserID: "local", Op: op, OpID: id, TurnID: turnID, Params: raw})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// 多写回合：轮前快照 + 两次真实写入 + 只靠回执结算，撤销必须覆盖中间每个版本。
func TestUndoAssistantTurnVerifiedSequentialOperations(t *testing.T) {
	h := newTurnOperations(t)
	before, err := h.s.BeginAssistantTurn("local", "c", "aabbcc", app.AssistantTurnInput{})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"first", "second"} {
		h.run(t, "canvas.nodes.create", id, "aabbcc", map[string]any{"nodes": []any{map[string]any{"title": id, "type": "text"}}})
	}
	if err := h.s.FinalizeAssistantTurn("aabbcc"); err != nil {
		t.Fatal(err)
	}
	revision, err := h.s.UndoAssistantTurn("local", "c", "aabbcc")
	if err != nil {
		t.Fatalf("two committed assistant writes must undo: %v", err)
	}
	doc := h.document(t)
	if revision != before+3 || len(doc["nodes"].([]any)) != 1 {
		t.Fatalf("restore failed: %v", doc)
	}
}

// 没有结算也要能撤销：模拟后端在回合中途退出，只在磁盘上留下轮前快照与回执。
func TestUndoAssistantTurnRecoversWhenSettlementNeverRan(t *testing.T) {
	h := newTurnOperations(t)
	before, err := h.s.BeginAssistantTurn("local", "c", "00112233aabbccdd", app.AssistantTurnInput{})
	if err != nil {
		t.Fatal(err)
	}
	h.run(t, "canvas.nodes.create", "recovered", "00112233aabbccdd",
		map[string]any{"nodes": []any{map[string]any{"title": "恢复", "type": "text"}}})
	// 刻意不调用 FinalizeAssistantTurn：撤销必须自己从回执重建这一轮的改动。
	restored, err := h.s.UndoAssistantTurn("local", "c", "00112233aabbccdd")
	if err != nil {
		t.Fatalf("unsettled turn must still undo from receipts: %v", err)
	}
	if restored <= before {
		t.Fatalf("undo must produce a new revision: %d <= %d", restored, before)
	}
	doc := h.document(t)
	if len(doc["nodes"].([]any)) != 1 {
		t.Fatalf("restore failed: %v", doc)
	}
	if raw, err := h.s.UserCanvasProject("local", "c"); err != nil || !strings.Contains(string(raw), "original") {
		t.Fatalf("pre-turn document not restored: %s %v", raw, err)
	}
}
