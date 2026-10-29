package agentops_test

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/model"
)

// 稳定 operationId 的跨回合重放不能把归属搬走：同一 opId 回读原结果时，
// 回执仍然属于最早执行它的那一轮，新回合不能借重放「认领」别人的写入。
func TestStableReplayDoesNotMoveTurnAttribution(t *testing.T) {
	h := newHarness(t)
	for _, turnID := range []string{"aaaabbbb", "ccccdddd"} {
		if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turnID, app.AssistantTurnInput{}); err != nil {
			t.Fatal(err)
		}
	}
	body := map[string]any{"canvasId": h.canvasID, "expectedRevision": h.revision,
		"nodes": []any{map[string]any{"title": "稳定身份", "type": "image"}}}
	params := mustRaw(t, body)
	first, err := h.registry.Execute(agentops.Request{Op: "canvas.nodes.create", OpID: "stable-op-1",
		UserID: "local", Params: params, TurnID: "aaaabbbb"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Replayed {
		t.Fatal("首次执行不应是回放")
	}
	replay, err := h.registry.Execute(agentops.Request{Op: "canvas.nodes.create", OpID: "stable-op-1",
		UserID: "local", Params: params, TurnID: "ccccdddd"})
	if err != nil {
		t.Fatal(err)
	}
	if !replay.Replayed || mustJSON(t, replay.Result) != mustJSON(t, first.Result) {
		t.Fatal("同一 opId 同 payload 必须回读原结果")
	}
	if record := lookupOpRecord(t, h, "stable-op-1"); record.TurnID != "aaaabbbb" {
		t.Fatalf("重放不能把归属搬到新回合: %q", record.TurnID)
	}
}

// 没有回合归属的外部写入（CLI/MCP）保持 turn_id 为空，不会被误当成某轮助手的改动。
func TestExternalWriteHasNoTurnAttribution(t *testing.T) {
	h := newHarness(t)
	params := mustRaw(t, map[string]any{"canvasId": h.canvasID, "expectedRevision": h.revision,
		"nodes": []any{map[string]any{"title": "外部写入", "type": "image"}}})
	if _, err := h.registry.Execute(agentops.Request{Op: "canvas.nodes.create", OpID: "external-op-1",
		UserID: "local", Params: params}); err != nil {
		t.Fatal(err)
	}
	if record := lookupOpRecord(t, h, "external-op-1"); record.TurnID != "" {
		t.Fatalf("外部写入不应带回合归属: %q", record.TurnID)
	}
}

// 严格解码：未知字段（含 patch/nodes 内部）整批拒绝，写入与幂等记录都不落地。
func TestStrictDecodeRejectsUnknownFieldsBeforeWriting(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		name, op, opID string
		build          func() map[string]any
		field          string
	}{
		{"顶层混入未知字段", "canvas.nodes.create", "unknown-top", func() map[string]any {
			return map[string]any{"canvasId": h.canvasID, "expectedRevision": h.revision,
				"nodes": []any{map[string]any{"title": "A", "type": "image"}}, "temperature": 0.7}
		}, "temperature"},
		{"patch 内混入未知字段", "canvas.node.update", "unknown-patch", func() map[string]any {
			return map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": h.revision,
				"patch": map[string]any{"title": "A", "temperature": 0.7}}
		}, "temperature"},
		{"nodes 项内混入未知字段", "canvas.nodes.create", "unknown-node", func() map[string]any {
			return map[string]any{"canvasId": h.canvasID, "expectedRevision": h.revision,
				"nodes": []any{map[string]any{"title": "A", "type": "image", "temperature": 0.7}}}
		}, "temperature"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := mustJSON(t, h.canvas(t))
			_, err := h.registry.Execute(agentops.Request{Op: tc.op, OpID: tc.opID, UserID: "local", Params: mustRaw(t, tc.build())})
			opErr := agentops.AsError(err)
			if opErr == nil || opErr.Code != agentops.CodeInvalidArgument || opErr.Reason != "unknown_field" {
				t.Fatalf("未知字段必须整批拒绝，得到 %v", err)
			}
			if opErr.Details["field"] != tc.field {
				t.Fatalf("未知字段名应为 %s，得到 %v", tc.field, opErr.Details["field"])
			}
			if after := mustJSON(t, h.canvas(t)); after != before {
				t.Fatal("被拒绝的请求不能改动画布")
			}
			if countOpRecords(t, h, tc.opID) != 0 {
				t.Fatal("被拒绝的请求不能留下幂等记录")
			}
		})
	}
}

// schema 的 operationId 与 envelope 的 opId 冲突必须明确拒绝，不能悄悄任选一个。
func TestOperationIDConflictIsExplicit(t *testing.T) {
	h := newHarness(t)
	body := map[string]any{"canvasId": h.canvasID, "expectedRevision": h.revision,
		"nodes": []any{map[string]any{"title": "A", "type": "image"}}, "operationId": "schema-id"}
	params := mustRaw(t, body)
	before := mustJSON(t, h.canvas(t))

	_, err := h.registry.Execute(agentops.Request{Op: "canvas.nodes.create", OpID: "envelope-id", UserID: "local", Params: params})
	opErr := agentops.AsError(err)
	if opErr == nil || opErr.Code != agentops.CodeInvalidArgument || opErr.Reason != "operation_id_conflict" {
		t.Fatalf("两个不一致的幂等身份必须被拒绝，得到 %v", err)
	}
	if after := mustJSON(t, h.canvas(t)); after != before {
		t.Fatal("冲突请求不能改动画布")
	}
	if countOpRecords(t, h, "envelope-id") != 0 || countOpRecords(t, h, "schema-id") != 0 {
		t.Fatal("冲突请求不能落地任何幂等记录")
	}

	// 两边一致时按同一个身份执行并回放。
	first, err := h.registry.Execute(agentops.Request{Op: "canvas.nodes.create", OpID: "schema-id", UserID: "local", Params: params})
	if err != nil {
		t.Fatal(err)
	}
	replay, err := h.registry.Execute(agentops.Request{Op: "canvas.nodes.create", OpID: "schema-id", UserID: "local", Params: params})
	if err != nil {
		t.Fatal(err)
	}
	if !replay.Replayed || mustJSON(t, replay.Result) != mustJSON(t, first.Result) {
		t.Fatal("同一个幂等身份的重试必须回读原结果")
	}
}

func mustRaw(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func lookupOpRecord(t *testing.T, h *harness, opID string) model.AgentOpRecord {
	t.Helper()
	var record model.AgentOpRecord
	if err := h.service.Database().Where("user_id = ? AND op_id = ?", "local", opID).First(&record).Error; err != nil {
		t.Fatalf("读取操作回执失败: %v", err)
	}
	return record
}

func countOpRecords(t *testing.T, h *harness, opID string) int64 {
	t.Helper()
	var count int64
	if err := h.service.Database().Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ?", "local", opID).
		Count(&count).Error; err != nil {
		t.Fatalf("统计操作回执失败: %v", err)
	}
	return count
}
