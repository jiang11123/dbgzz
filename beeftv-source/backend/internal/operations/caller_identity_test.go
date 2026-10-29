package operations_test

import (
	"encoding/json"
	"errors"
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
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
)

type harness struct {
	registry *operations.Registry
	service  *app.Service
	userID   string
	canvasID string
	revision int64
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "operations.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "local", Name: "本地工作区"}).Error; err != nil {
		t.Fatal(err)
	}
	service := app.NewLocal(repository.New(db), t.TempDir())
	registry := operations.NewRegistry(service, operations.NewStore(db))
	operations.RegisterDefaultOps(registry)
	canvasID := "ops-canvas"
	encoded, err := json.Marshal(map[string]any{
		"id": canvasID, "title": "操作层画布", "revision": 0,
		"nodes": []any{
			map[string]any{"id": "n1", "type": "image", "title": "镜头1", "position": map[string]any{"x": 1, "y": 1},
				"width": 320, "height": 220, "metadata": map[string]any{"prompt": "原始"}},
			map[string]any{"id": "n2", "type": "image", "title": "镜头2", "position": map[string]any{"x": 2, "y": 2},
				"width": 320, "height": 220, "metadata": map[string]any{"prompt": "原始2"}},
		},
		"connections": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpsertUserCanvasProject("local", encoded); err != nil {
		t.Fatal(err)
	}
	raw, err := service.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	return &harness{registry: registry, service: service, userID: "local", canvasID: canvasID, revision: int64(stored["revision"].(float64))}
}

func (h *harness) execute(t *testing.T, caller operations.Caller, op, opID string, params map[string]any) (operations.Result, error) {
	t.Helper()
	encoded, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	return h.registry.Execute(operations.Request{
		Op: op, OpID: opID, UserID: h.userID, Caller: caller, Params: encoded,
	})
}

func (h *harness) assistant() operations.Caller {
	return operations.AssistantCaller(&agentops.AssistantScope{
		CanvasID:  h.canvasID,
		AssetIDs:  map[string]bool{},
		CanvasIDs: map[string]bool{},
		TaskIDs:   map[string]bool{},
	}, false)
}

func (h *harness) revisionNow(t *testing.T) int64 {
	t.Helper()
	raw, err := h.service.UserCanvasProject(h.userID, h.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	return int64(stored["revision"].(float64))
}

func opErr(t *testing.T, err error) *operations.Error {
	t.Helper()
	var typed *operations.Error
	if !errors.As(err, &typed) {
		t.Fatalf("期望结构化操作错误，得到 %v", err)
	}
	return typed
}

func TestSameWriteOperationAcrossManualAssistantExternal(t *testing.T) {
	h := newHarness(t)
	callers := []struct {
		name   string
		caller operations.Caller
	}{
		{"manual", operations.ManualCaller(false)},
		{"assistant", h.assistant()},
		{"external", operations.ExternalCaller(false)},
	}
	for _, item := range callers {
		t.Run(item.name, func(t *testing.T) {
			revision := h.revisionNow(t)
			result, err := h.execute(t, item.caller, "canvas.nodes.create", "create-"+item.name, map[string]any{
				"canvasId": h.canvasID, "expectedRevision": revision,
				"nodes": []any{map[string]any{"title": "由" + item.name + "创建", "type": "image"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			if result.Replayed || result.Caller != item.caller.Kind || result.Revision == 0 || result.OpID != "create-"+item.name {
				t.Fatalf("信封异常: %#v", result)
			}
			receipt := result.Receipt("")
			if receipt.OperationID != result.OpID || receipt.Revision != result.Revision || receipt.Caller != item.caller.Kind {
				t.Fatalf("回执异常: %#v", receipt)
			}
		})
	}
}

func TestReplayAndConflictAreSharedAcrossCallers(t *testing.T) {
	h := newHarness(t)
	params := map[string]any{
		"canvasId": h.canvasID, "expectedRevision": h.revision,
		"nodes": []any{map[string]any{"title": "共享幂等", "type": "image"}},
	}
	first, err := h.execute(t, operations.ManualCaller(false), "canvas.nodes.create", "shared-op", params)
	if err != nil {
		t.Fatal(err)
	}
	before := h.revisionNow(t)
	for _, caller := range []operations.Caller{h.assistant(), operations.ExternalCaller(false), operations.ManualCaller(false)} {
		replay, err := h.execute(t, caller, "canvas.nodes.create", "shared-op", params)
		if err != nil {
			t.Fatalf("%s 回放失败: %v", caller.Kind, err)
		}
		if !replay.Replayed || replay.Revision != first.Revision {
			t.Fatalf("%s 必须回读原结果: %#v", caller.Kind, replay)
		}
	}
	if h.revisionNow(t) != before {
		t.Fatal("回放推进了画布版本")
	}
	_, err = h.execute(t, operations.ExternalCaller(false), "canvas.nodes.create", "shared-op", map[string]any{
		"canvasId": h.canvasID, "expectedRevision": h.revision,
		"nodes": []any{map[string]any{"title": "不同内容", "type": "image"}},
	})
	if got := opErr(t, err); got.Code != operations.CodeConflict || got.Reason != "operation_id_reused_with_different_payload" {
		t.Fatalf("不同 payload 应为冲突，得到 %v", err)
	}
}

func TestAuthorizationHappensBeforeReplay(t *testing.T) {
	h := newHarness(t)
	params := map[string]any{
		"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": h.revision,
		"patch": map[string]any{"title": "已提交标题"},
	}
	first, err := h.execute(t, operations.ManualCaller(false), "canvas.node.update", "auth-before-replay", params)
	if err != nil {
		t.Fatal(err)
	}
	before := h.revisionNow(t)
	_, err = h.execute(t, operations.ExternalCaller(true), "canvas.node.update", "auth-before-replay", params)
	if got := opErr(t, err); got.Code != operations.CodeReadOnly || got.Reason != "read_only_client" {
		t.Fatalf("只读回放应在授权阶段被拒: %v", err)
	}
	foreign := operations.AssistantCaller(&agentops.AssistantScope{CanvasID: "other-canvas"}, false)
	_, err = h.execute(t, foreign, "canvas.node.update", "auth-before-replay", params)
	if got := opErr(t, err); got.Code != operations.CodePermissionDenied || got.Reason != "scope_denied" {
		t.Fatalf("越界助手回放应在授权阶段被拒: %v", err)
	}
	if h.revisionNow(t) != before {
		t.Fatal("被拒绝的回放改动画布")
	}
	replay, err := h.execute(t, operations.ManualCaller(false), "canvas.node.update", "auth-before-replay", params)
	if err != nil || !replay.Replayed || replay.Revision != first.Revision {
		t.Fatalf("授权通过后仍应回放: %#v %v", replay, err)
	}
}

func TestAssistantCannotUseWorkspaceWideOps(t *testing.T) {
	h := newHarness(t)
	visible := map[string]bool{}
	for _, descriptor := range h.registry.List(h.assistant()) {
		visible[descriptor.ID] = true
		if !descriptor.ReadOnly && jsonContains(descriptor.Params, "operationId") {
			t.Fatalf("助手 schema 不应要求模型填写 operationId: %s", descriptor.ID)
		}
	}
	if visible["asset.list"] || visible["canvas.search"] {
		t.Fatalf("助手看到了工作区级操作: %v", visible)
	}
	_, err := h.execute(t, h.assistant(), "asset.list", "", map[string]any{})
	if got := opErr(t, err); got.Code != operations.CodePermissionDenied {
		t.Fatalf("助手执行 asset.list 应被拒: %v", err)
	}
	manual := h.registry.List(operations.ManualCaller(false))
	if len(manual) != 41 {
		t.Fatalf("手工 UI 应看到完整 41 项能力: %d", len(manual))
	}
	foundDocumentCommit := false
	for _, descriptor := range manual {
		if descriptor.ID == "canvas.document.commit" {
			foundDocumentCommit = true
		}
	}
	if !foundDocumentCommit {
		t.Fatal("手工 UI 必须看到 canvas.document.commit")
	}
	if len(manual) <= len(visible) {
		t.Fatalf("手工 UI 应看到完整能力: %d <= %d", len(manual), len(visible))
	}
	foundOperationID := false
	for _, descriptor := range manual {
		if !descriptor.ReadOnly && jsonContains(descriptor.Params, "operationId") {
			foundOperationID = true
		}
	}
	if !foundOperationID {
		t.Fatal("手工 UI 的写操作 schema 必须带 operationId")
	}
}

func TestFailedWriteDoesNotLeaveReceipt(t *testing.T) {
	h := newHarness(t)
	_, err := h.execute(t, operations.ManualCaller(false), "canvas.nodes.create", "failed-write", map[string]any{
		"canvasId": h.canvasID, "expectedRevision": h.revision + 99,
		"nodes": []any{map[string]any{"title": "不应落盘", "type": "image"}},
	})
	if err == nil {
		t.Fatal("过期 revision 必须失败")
	}
	before := h.revisionNow(t)
	retry, replayErr := h.execute(t, operations.ExternalCaller(false), "canvas.nodes.create", "failed-write", map[string]any{
		"canvasId": h.canvasID, "expectedRevision": before,
		"nodes": []any{map[string]any{"title": "失败后重试", "type": "image"}},
	})
	if replayErr != nil {
		t.Fatalf("失败写入不应留下回执: %v", replayErr)
	}
	if retry.Replayed {
		t.Fatal("失败后的同 operationId 不应是回放")
	}
}

func TestPaidProposeRejectsIdempotencyKey(t *testing.T) {
	h := newHarness(t)
	_, err := h.execute(t, operations.ManualCaller(false), "canvas.generation.propose", "should-not-exist", map[string]any{
		"canvasId": h.canvasID, "nodeIds": []any{"n1"}, "kind": "image",
	})
	if got := opErr(t, err); got.Reason != "unexpected_op_id" {
		t.Fatalf("只读提议不应接受 opId: %v", err)
	}
}

func jsonContains(raw json.RawMessage, needle string) bool {
	body := string(raw)
	return strings.Contains(body, needle)
}
