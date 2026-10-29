package app

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// 按轮撤销用真实 SQLite 与真实画布写入验证：撤销必须是「写回旧文档的新版本」，
// 而不是把 revision 回退（回退会让页面的外部版本刷新看不见这次变化）。
func newAssistantTurnService(t *testing.T) (*Service, string, int64) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "turns.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("打开临时库失败: %v", err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatalf("迁移失败: %v", err)
	}
	if err := db.Create(&model.Workspace{ID: "local", Name: "本地工作区"}).Error; err != nil {
		t.Fatalf("创建工作区失败: %v", err)
	}
	service := NewLocal(repository.New(db), t.TempDir())
	doc := map[string]any{"id": "canvas-1", "title": "撤销回归", "revision": 0,
		"nodes":       []any{map[string]any{"id": "n1", "type": "text", "title": "原节点", "position": map[string]any{"x": 0, "y": 0}}},
		"connections": []any{}}
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpsertUserCanvasProject("local", encoded); err != nil {
		t.Fatalf("写入初始画布失败: %v", err)
	}
	return service, "canvas-1", canvasRevisionOf(t, service, "canvas-1")
}

func canvasRevisionOf(t *testing.T, service *Service, canvasID string) int64 {
	t.Helper()
	raw, err := service.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatalf("读取画布失败: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return assistantDocRevision(doc)
}

// 模拟一轮助手写入：加一个节点并推进 revision。
func appendNode(t *testing.T, service *Service, canvasID, nodeID string) int64 {
	t.Helper()
	raw, err := service.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	nodes, _ := doc["nodes"].([]any)
	doc["nodes"] = append(nodes, map[string]any{"id": nodeID, "type": "text", "title": nodeID,
		"position": map[string]any{"x": 10, "y": 10}})
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := service.UpsertUserCanvasProject("local", encoded)
	if err != nil {
		t.Fatalf("写入画布失败: %v", err)
	}
	return summary.Revision
}

func nodeIDs(t *testing.T, service *Service, canvasID string) []string {
	t.Helper()
	raw, err := service.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Nodes []struct {
			ID string `json:"id"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(doc.Nodes))
	for _, node := range doc.Nodes {
		out = append(out, node.ID)
	}
	return out
}

// recordTurnReceipt 落一条带回合归属的操作回执。
//
// app 包内测试仍不直接 import agentops：回执重建规则在这里用仓储记录覆盖，
// 真实注册表与事务入口在 assistant_turns_operations_test.go。
// 操作核已迁到 operations，不再反向依赖 app。
func recordTurnReceipt(t *testing.T, service *Service, turnID, opID, op string, payload map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	record := model.AgentOpRecord{UserID: "local", OpID: opID, Op: op, Status: "succeeded",
		ResultJSON: string(encoded), TurnID: turnID}
	if err := service.Database().Create(&record).Error; err != nil {
		t.Fatal(err)
	}
}

func settleTurn(t *testing.T, service *Service, turnID string) {
	t.Helper()
	if err := service.FinalizeAssistantTurn(turnID); err != nil {
		t.Fatalf("结算回合失败: %v", err)
	}
}

func TestUndoAssistantTurnRestoresPreTurnDocumentAsNewRevision(t *testing.T) {
	service, canvasID, revision := newAssistantTurnService(t)
	turnID := "aabbccdd11223344"

	before, err := service.BeginAssistantTurn("local", canvasID, turnID, AssistantTurnInput{})
	if err != nil {
		t.Fatalf("轮前快照失败: %v", err)
	}
	if before != revision {
		t.Fatalf("轮前版本应为 %d，得到 %d", revision, before)
	}
	after := appendNode(t, service, canvasID, "n2")
	recordTurnReceipt(t, service, turnID, "op-create-n2", "canvas.nodes.create",
		map[string]any{"canvasId": canvasID, "revision": after, "created": []any{map[string]any{"id": "n2", "title": "n2"}}})
	settleTurn(t, service, turnID)

	restored, err := service.UndoAssistantTurn("local", canvasID, turnID)
	if err != nil {
		t.Fatalf("撤销失败: %v", err)
	}
	if restored <= after {
		t.Fatalf("撤销必须产生新版本（> %d），得到 %d", after, restored)
	}
	reopened := NewLocal(repository.New(service.Database()), service.dataDir)
	if !reopened.AssistantTurnUndone("local", canvasID, turnID) {
		t.Fatal("reopened service lost durable undo receipt")
	}
	if reopened.AssistantTurnUndone("other-user", canvasID, turnID) || reopened.AssistantTurnUndone("local", "other-canvas", turnID) || reopened.AssistantTurnUndone("local", canvasID, "../../elsewhere") {
		t.Fatal("undo receipt leaked across scope")
	}
	ids := nodeIDs(t, service, canvasID)
	if len(ids) != 1 || ids[0] != "n1" {
		t.Fatalf("撤销后应回到轮前节点集合，得到 %v", ids)
	}

	if _, err := service.UndoAssistantTurn("local", canvasID, turnID); err == nil {
		t.Fatal("重复撤销应被拒")
	} else if turnErr, isTurnErr := err.(*AssistantTurnError); !isTurnErr || turnErr.Reason != AssistantTurnReasonAlreadyUndone {
		t.Fatalf("重复撤销原因应为 %s，得到 %v", AssistantTurnReasonAlreadyUndone, err)
	}
}

func TestUndoAssistantTurnRejectsLaterCanvasChanges(t *testing.T) {
	service, canvasID, _ := newAssistantTurnService(t)
	turnID := "ffee001122334455"

	_, err := service.BeginAssistantTurn("local", canvasID, turnID, AssistantTurnInput{})
	if err != nil {
		t.Fatal(err)
	}
	after := appendNode(t, service, canvasID, "n2")
	recordTurnReceipt(t, service, turnID, "op-create-n2", "canvas.nodes.create",
		map[string]any{"canvasId": canvasID, "revision": after, "created": []any{map[string]any{"id": "n2", "title": "n2"}}})
	settleTurn(t, service, turnID)
	// 用户在这轮之后又自己改了画布：撤销会吞掉用户的编辑，必须停下来。
	appendNode(t, service, canvasID, "n3")

	_, err = service.UndoAssistantTurn("local", canvasID, turnID)
	turnErr, isTurnErr := err.(*AssistantTurnError)
	if !isTurnErr || turnErr.Reason != AssistantTurnReasonCanvasChanged {
		t.Fatalf("原因应为 %s，得到 %v", AssistantTurnReasonCanvasChanged, err)
	}
}

func TestUndoAssistantTurnPreservesExternalWriteDuringTurn(t *testing.T) {
	service, canvasID, _ := newAssistantTurnService(t)
	turnID := "e030001122334455"
	_, err := service.BeginAssistantTurn("local", canvasID, turnID, AssistantTurnInput{})
	if err != nil {
		t.Fatal(err)
	}
	appendNode(t, service, canvasID, "S")
	after := appendNode(t, service, canvasID, "T")
	// 只有 T 带回合回执：中间那次外部写入没有归属，撤销必须停下来。
	recordTurnReceipt(t, service, turnID, "op-create-T", "canvas.nodes.create",
		map[string]any{"canvasId": canvasID, "revision": after, "created": []any{map[string]any{"id": "T", "title": "T"}}})
	settleTurn(t, service, turnID)
	_, err = service.UndoAssistantTurn("local", canvasID, turnID)
	if got := nodeIDs(t, service, canvasID); !reflect.DeepEqual(got, []string{"n1", "S", "T"}) {
		t.Fatalf("unsafe undo erased external S: nodes=%v err=%v", got, err)
	}
	turnErr, ok := err.(*AssistantTurnError)
	if !ok || turnErr.Reason != AssistantTurnReasonCanvasChanged {
		t.Fatalf("unsafe undo must be rejected: %v", err)
	}
}

func TestUndoAssistantTurnRejectsSameNodeExternalEdit(t *testing.T) {
	service, canvasID, _ := newAssistantTurnService(t)
	turnID := "e030001122334457"
	before, err := service.BeginAssistantTurn("local", canvasID, turnID, AssistantTurnInput{})
	if err != nil {
		t.Fatal(err)
	}
	external, err := service.UpdateUserCanvasNodeFieldsWithTx(service.Database(), "local", canvasID, "n1", map[string]any{"title": "external S"}, before)
	if err != nil {
		t.Fatal(err)
	}
	after, err := service.UpdateUserCanvasNodeFieldsWithTx(service.Database(), "local", canvasID, "n1", map[string]any{"content": "assistant T"}, external.Revision)
	if err != nil {
		t.Fatal(err)
	}
	recordTurnReceipt(t, service, turnID, "op-update-n1", "canvas.node.update",
		map[string]any{"canvasId": canvasID, "revision": after.Revision, "nodeId": "n1"})
	settleTurn(t, service, turnID)
	want, err := service.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UndoAssistantTurn("local", canvasID, turnID); err == nil {
		t.Fatal("same-node external edit must block undo")
	}
	got, err := service.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatal("external edit was not preserved")
	}
}

func TestUndoAssistantTurnRejectsUnreportedSingleWrite(t *testing.T) {
	service, canvasID, _ := newAssistantTurnService(t)
	turnID := "e030001122334456"
	_, err := service.BeginAssistantTurn("local", canvasID, turnID, AssistantTurnInput{})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := service.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	nodes := doc["nodes"].([]any)
	nodes[0].(map[string]any)["title"] = "unreported S"
	doc["nodes"] = append(nodes, map[string]any{"id": "T", "type": "text", "title": "T"})
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := service.UpsertUserCanvasProject("local", encoded)
	if err != nil {
		t.Fatal(err)
	}
	// 回执说这一版只新建了 T，实际文档还改了 n1：完整性核对必须拒绝撤销。
	recordTurnReceipt(t, service, turnID, "op-unreported", "canvas.nodes.create",
		map[string]any{"canvasId": canvasID, "revision": summary.Revision, "created": []any{map[string]any{"id": "T", "title": "T"}}})
	settleTurn(t, service, turnID)
	want, err := service.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UndoAssistantTurn("local", canvasID, turnID); err == nil {
		t.Fatal("unreported node edit must block undo")
	}
	got, err := service.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("rejected undo changed document: %s", got)
	}
}

func TestUndoAssistantTurnReasonsForMissingAndUnchangedTurns(t *testing.T) {
	service, canvasID, _ := newAssistantTurnService(t)

	if _, err := service.UndoAssistantTurn("local", canvasID, "0011223344556677"); err == nil {
		t.Fatal("不存在的轮次应被拒")
	} else if turnErr, isTurnErr := err.(*AssistantTurnError); !isTurnErr || turnErr.Reason != AssistantTurnReasonNotFound {
		t.Fatalf("原因应为 %s，得到 %v", AssistantTurnReasonNotFound, err)
	}

	// 非十六进制轮次标识不能变成路径片段。
	if _, err := service.UndoAssistantTurn("local", canvasID, "../../etc/passwd"); err == nil {
		t.Fatal("非法轮次标识应被拒")
	}

	turnID := "abcdefabcdef0000"
	if _, err := service.BeginAssistantTurn("local", canvasID, turnID, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	// 这一轮没写画布：轮记录要留下，撤销按「没有改动」拒绝，而不是说轮次不存在。
	settleTurn(t, service, turnID)
	if _, err := service.UndoAssistantTurn("local", canvasID, turnID); err == nil {
		t.Fatal("没有改动的轮次应被拒")
	} else if turnErr, isTurnErr := err.(*AssistantTurnError); !isTurnErr || turnErr.Reason != AssistantTurnReasonNoChange {
		t.Fatalf("原因应为 %s，得到 %v", AssistantTurnReasonNoChange, err)
	}
}

// 轮次快照不属于别的画布或别的用户：错配时按不存在处理，不能跨 scope 恢复文档。
func TestUndoAssistantTurnIsScopedToOwnerAndCanvas(t *testing.T) {
	service, canvasID, _ := newAssistantTurnService(t)
	turnID := "1234567890abcdef"
	_, err := service.BeginAssistantTurn("local", canvasID, turnID, AssistantTurnInput{})
	if err != nil {
		t.Fatal(err)
	}
	after := appendNode(t, service, canvasID, "n2")
	recordTurnReceipt(t, service, turnID, "op-create-n2", "canvas.nodes.create",
		map[string]any{"canvasId": canvasID, "revision": after, "created": []any{map[string]any{"id": "n2", "title": "n2"}}})
	settleTurn(t, service, turnID)
	if _, err := service.UndoAssistantTurn("other-user", canvasID, turnID); err == nil {
		t.Fatal("其他用户不应能撤销这一轮")
	}
	if _, err := service.UndoAssistantTurn("local", "canvas-other", turnID); err == nil {
		t.Fatal("其他画布不应能撤销这一轮")
	}
}

func TestAssistantTurnsOrInitDoesNotAssignLazyField(t *testing.T) {
	service := &Service{dataDir: t.TempDir()}
	first := service.assistantTurnsOrInit()
	if first == nil {
		t.Fatal("literal service must still construct a domain fallback")
	}
	if service.assistantTurns != nil {
		t.Fatal("lazy fallback must not assign a shared mutable field")
	}
	second := service.assistantTurnsOrInit()
	if second == nil || second == first {
		t.Fatal("stateless fallback must return a fresh instance")
	}
}
