package operations_test

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func TestDocumentCommitManualAndAgentInterleaving(t *testing.T) {
	h := newHarness(t)
	overlay := map[string]any{
		"id": h.canvasID, "title": "手工整页",
		"nodes": []any{
			map[string]any{"id": "n1", "type": "image", "title": "手工镜头", "position": map[string]any{"x": 1, "y": 1},
				"width": 320, "height": 220, "metadata": map[string]any{"prompt": "手工"}},
			map[string]any{"id": "n2", "type": "image", "title": "镜头2", "position": map[string]any{"x": 2, "y": 2},
				"width": 320, "height": 220, "metadata": map[string]any{"prompt": "原始2"}},
		},
		"connections": []any{},
	}
	first, err := h.execute(t, operations.ManualCaller(false), "canvas.document.commit", "manual-doc-1", map[string]any{
		"canvasId": h.canvasID, "expectedRevision": h.revisionNow(t), "document": overlay,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Replayed || first.Caller != operations.CallerManual || first.Revision == 0 {
		t.Fatalf("手工提交信封异常: %#v", first)
	}
	agentRev := h.revisionNow(t)
	agent, err := h.execute(t, h.assistant(), "canvas.node.update", "agent-patch-1", map[string]any{
		"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": agentRev,
		"patch": map[string]any{"title": "助手改名"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if agent.Revision == first.Revision {
		t.Fatal("助手写入应推进 revision")
	}
	_, err = h.execute(t, operations.ManualCaller(false), "canvas.document.commit", "manual-stale", map[string]any{
		"canvasId": h.canvasID, "expectedRevision": first.Revision, "document": overlay,
	})
	if got := opErr(t, err); got.Code != operations.CodeConflict {
		t.Fatalf("陈旧手工提交必须冲突: %v", err)
	}
	raw, err := h.service.UserCanvasProject(h.userID, h.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	nodes := stored["nodes"].([]any)
	title, _ := nodes[0].(map[string]any)["title"].(string)
	if title != "助手改名" {
		t.Fatalf("陈旧手工提交不得覆盖助手改动: %s", raw)
	}
}

func TestDocumentCommitReplayAndPayloadConflict(t *testing.T) {
	h := newHarness(t)
	params := map[string]any{
		"canvasId": h.canvasID, "expectedRevision": h.revisionNow(t),
		"document": map[string]any{"title": "幂等提交", "nodes": []any{}, "connections": []any{}},
	}
	first, err := h.execute(t, operations.ManualCaller(false), "canvas.document.commit", "doc-replay", params)
	if err != nil {
		t.Fatal(err)
	}
	before := h.revisionNow(t)
	replay, err := h.execute(t, operations.ExternalCaller(false), "canvas.document.commit", "doc-replay", params)
	if err != nil {
		t.Fatal(err)
	}
	if !replay.Replayed || replay.Revision != first.Revision {
		t.Fatalf("丢失应答重放必须回读原结果: %#v", replay)
	}
	if h.revisionNow(t) != before {
		t.Fatal("重放推进了画布版本")
	}
	var receipts int64
	if err := h.service.Database().Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ?", h.userID, "doc-replay").Count(&receipts).Error; err != nil {
		t.Fatal(err)
	}
	if receipts != 1 {
		t.Fatalf("同一操作应只有一条回执，得到 %d", receipts)
	}
	_, err = h.execute(t, operations.ManualCaller(false), "canvas.document.commit", "doc-replay", map[string]any{
		"canvasId": h.canvasID, "expectedRevision": h.revision,
		"document": map[string]any{"title": "不同内容", "nodes": []any{}, "connections": []any{}},
	})
	if got := opErr(t, err); got.Reason != "operation_id_reused_with_different_payload" {
		t.Fatalf("不同 payload 应为冲突，得到 %v", err)
	}
}

func TestAssistantCannotCommitDocument(t *testing.T) {
	h := newHarness(t)
	for _, descriptor := range h.registry.List(h.assistant()) {
		if descriptor.ID == "canvas.document.commit" {
			t.Fatal("助手能力发现不得包含整页文档提交")
		}
	}
	_, err := h.execute(t, h.assistant(), "canvas.document.commit", "assistant-doc", map[string]any{
		"canvasId": h.canvasID, "expectedRevision": h.revisionNow(t),
		"document": map[string]any{"title": "越权", "nodes": []any{}, "connections": []any{}},
	})
	if got := opErr(t, err); got.Code != operations.CodePermissionDenied {
		t.Fatalf("助手执行整页提交应被拒: %v", err)
	}
	empty := operations.AssistantCaller(&agentops.AssistantScope{}, false)
	_, err = h.execute(t, empty, "canvas.document.commit", "empty-scope-doc", map[string]any{
		"canvasId": h.canvasID, "expectedRevision": h.revisionNow(t),
		"document": map[string]any{"title": "空范围", "nodes": []any{}, "connections": []any{}},
	})
	if got := opErr(t, err); got.Code != operations.CodePermissionDenied {
		t.Fatalf("空助手范围执行整页提交应被拒: %v", err)
	}
}

func TestDocumentCommitRequiresExpectedRevision(t *testing.T) {
	h := newHarness(t)
	_, err := h.execute(t, operations.ManualCaller(false), "canvas.document.commit", "missing-rev", map[string]any{
		"canvasId": h.canvasID, "document": map[string]any{"title": "缺版本"},
	})
	if got := opErr(t, err); got.Code != operations.CodeInvalidArgument {
		t.Fatalf("缺少 expectedRevision 应被拒: %v", err)
	}
}
