package app

import (
	"context"
	"encoding/json"
	"errors"
	"infinite-canvas/backend/internal/conversation"
	"infinite-canvas/backend/internal/taskbinding"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
)

type lockOrderFixture struct {
	t        *testing.T
	service  *Service
	registry *operations.Registry
	userID   string
	canvasID string
}

func newLockOrderFixture(t *testing.T) *lockOrderFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	dsn := filepath.Join(t.TempDir(), "lock-order.db") + "?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	pool.SetMaxOpenConns(1)
	pool.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = pool.Close() })
	db = db.WithContext(ctx)
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "local", Name: "本地工作区"}).Error; err != nil {
		t.Fatal(err)
	}
	service := NewLocal(repository.New(db), t.TempDir())
	encoded, err := json.Marshal(map[string]any{
		"id": "lock-canvas", "title": "锁顺序", "revision": 0,
		"nodes": []any{
			map[string]any{"id": "n1", "type": "text", "title": "节点", "position": map[string]any{"x": 1, "y": 1},
				"width": 320, "height": 220, "metadata": map[string]any{"content": "原始"}},
		},
		"connections": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpsertUserCanvasProject("local", encoded); err != nil {
		t.Fatal(err)
	}
	return &lockOrderFixture{t: t, service: service, registry: service.workspaceOperations(), userID: "local", canvasID: "lock-canvas"}
}

func (fx *lockOrderFixture) revision() int64 {
	fx.t.Helper()
	raw, err := fx.service.UserCanvasProject(fx.userID, fx.canvasID)
	if err != nil {
		fx.t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		fx.t.Fatal(err)
	}
	switch v := doc["revision"].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	default:
		fx.t.Fatalf("画布 revision 类型异常: %T", doc["revision"])
	}
	return 0
}

func (fx *lockOrderFixture) executeNodeUpdate() error {
	raw, err := json.Marshal(map[string]any{
		"canvasId": fx.canvasID, "nodeId": "n1", "expectedRevision": fx.revision(),
		"patch": map[string]any{"title": "事务内写入"}, "operationId": "lock-order-node-update",
	})
	if err != nil {
		return err
	}
	_, err = fx.registry.Execute(operations.Request{
		Op: "canvas.node.update", OpID: "lock-order-node-update",
		UserID: fx.userID, Caller: operations.ManualCaller(false), Params: raw,
	})
	return err
}

func (fx *lockOrderFixture) prepareUndo() {
	fx.t.Helper()
	if _, err := fx.service.BeginAssistantTurn(fx.userID, fx.canvasID, "aabbccddeeff0011", AssistantTurnInput{}); err != nil {
		fx.t.Fatal(err)
	}
	raw, err := json.Marshal(map[string]any{
		"canvasId": fx.canvasID, "expectedRevision": fx.revision(),
		"nodes":       []any{map[string]any{"title": "回合节点", "type": "text"}},
		"operationId": "lock-order-turn-create",
	})
	if err != nil {
		fx.t.Fatal(err)
	}
	if _, err := fx.registry.Execute(operations.Request{
		Op: "canvas.nodes.create", OpID: "lock-order-turn-create", TurnID: "aabbccddeeff0011",
		UserID: fx.userID, Caller: operations.ManualCaller(false), Params: raw,
	}); err != nil {
		fx.t.Fatal(err)
	}
	if err := fx.service.FinalizeAssistantTurn("aabbccddeeff0011"); err != nil {
		fx.t.Fatal(err)
	}
}

func (fx *lockOrderFixture) undo() error {
	_, err := fx.service.UndoAssistantTurn(fx.userID, fx.canvasID, "aabbccddeeff0011")
	return err
}

func (fx *lockOrderFixture) createTaskHoldingMutex(held chan struct{}) error {
	policy, err := fx.service.RuntimePolicy()
	if err != nil {
		return err
	}
	task := &model.Task{
		ID: "lock-create-1", UserID: fx.userID, Type: "canvas_text",
		Status: model.TaskStatusQueued, Prompt: "锁顺序创建", InputJSON: "{}",
	}
	fx.service.storageMu.Lock()
	defer fx.service.storageMu.Unlock()
	close(held)
	return createTaskWithStorageQuotaRepository(fx.service.repo, task, policy)
}

func (fx *lockOrderFixture) seedRunningTask() model.Task {
	fx.t.Helper()
	task := model.Task{
		ID: "lock-save-1", UserID: fx.userID, Status: model.TaskStatusRunning, InputJSON: `{"mode":"text"}`,
	}
	if err := fx.service.repo.Create(&task); err != nil {
		fx.t.Fatal(err)
	}
	return task
}

func (fx *lockOrderFixture) saveTaskHoldingMutex(task model.Task, held chan struct{}) error {
	fx.service.storageMu.Lock()
	defer fx.service.storageMu.Unlock()
	close(held)
	if _, err := fx.service.repo.UserStorageUsage(task.UserID); err != nil {
		return err
	}
	completed := task
	completed.Status = model.TaskStatusSucceeded
	completed.Stage = "任务完成"
	completed.Progress = 100
	completed.ResultJSON = `{"ok":true}`
	now := time.Now()
	completed.CompletedAt = &now
	return fx.service.repo.SaveTaskCompletion(&completed, model.TaskStatusRunning, nil)
}

func TestSingleConnectionOpsWriteAndAssistantUndoDoNotDeadlockAgainstTaskWrites(t *testing.T) {
	cases := []struct {
		name   string
		txPath string
		task   string
	}{
		{name: "ops node.update vs task create", txPath: "ops", task: "create"},
		{name: "ops node.update vs task save", txPath: "ops", task: "save"},
		{name: "assistant undo vs task create", txPath: "undo", task: "create"},
		{name: "assistant undo vs task save", txPath: "undo", task: "save"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newLockOrderFixture(t)
			if tc.txPath == "undo" {
				fx.prepareUndo()
			}
			var running model.Task
			if tc.task == "save" {
				running = fx.seedRunningTask()
			}
			runLockOrderAgainstTask(t, fx, tc.txPath, tc.task, running)
		})
	}
}

func runLockOrderAgainstTask(t *testing.T, fx *lockOrderFixture, txPath, taskPath string, running model.Task) {
	t.Helper()
	txReady := make(chan struct{})
	proceed := make(chan struct{})
	held := make(chan struct{})
	var txOnce sync.Once
	var proceedOnce sync.Once
	t.Cleanup(func() {
		proceedOnce.Do(func() { close(proceed) })
	})
	// Pause only this fixture's database after acquiring its transaction's
	// connection. No process-global hook is installed in production code.
	err := fx.service.repo.DB().Callback().Query().After("gorm:query").Register("test:lock-order", func(tx *gorm.DB) {
		if !repoHoldsTransaction(repository.New(tx)) {
			return
		}
		txOnce.Do(func() {
			close(txReady)
			select {
			case <-proceed:
			case <-time.After(4 * time.Second):
			}
		})
	})
	if err != nil {
		t.Fatal(err)
	}

	txErr := make(chan error, 1)
	go func() {
		if txPath == "undo" {
			txErr <- fx.undo()
			return
		}
		txErr <- fx.executeNodeUpdate()
	}()

	select {
	case <-txReady:
	case err := <-txErr:
		t.Fatalf("事务路径在 WithStorageLock 之前返回: %v", err)
	case <-time.After(4 * time.Second):
		t.Fatal("事务路径未进入 WithStorageLock")
	}

	taskErr := make(chan error, 1)
	go func() {
		if taskPath == "save" {
			taskErr <- fx.saveTaskHoldingMutex(running, held)
			return
		}
		taskErr <- fx.createTaskHoldingMutex(held)
	}()

	select {
	case <-held:
	case err := <-taskErr:
		t.Fatalf("任务路径在拿到 storageMu 之前返回: %v", err)
	case <-time.After(4 * time.Second):
		t.Fatal("任务路径未拿到 storageMu")
	}
	proceedOnce.Do(func() { close(proceed) })

	deadline := time.After(4 * time.Second)
	var gotTx, gotTask error
	gotTx, gotTask = errPending, errPending
	for gotTx == errPending || gotTask == errPending {
		select {
		case err := <-txErr:
			gotTx = err
		case err := <-taskErr:
			gotTask = err
		case <-deadline:
			t.Fatalf("单连接锁顺序未在时限内结束 tx=%v task=%v", pendingText(gotTx), pendingText(gotTask))
		}
	}
	if gotTx != nil {
		t.Fatalf("事务路径失败: %v", gotTx)
	}
	if gotTask != nil {
		t.Fatalf("任务路径失败: %v", gotTask)
	}
}

var errPending = errors.New("pending")

func pendingText(err error) string {
	if err == errPending {
		return "未返回"
	}
	if err == nil {
		return "ok"
	}
	return err.Error()
}

func TestMapConversationAttachErrorUsesTypedReasons(t *testing.T) {
	t.Helper()
	deleted := mapConversationAttachError(&conversation.Error{
		Status: http.StatusConflict, Reason: conversation.ReasonDeleted, Message: "对话已删除，无法再写入",
	})
	var bindErr *taskbinding.Error
	if !errors.As(deleted, &bindErr) || bindErr.Reason != "conversation_deleted" || bindErr.Status != 409 {
		t.Fatalf("deleted = %#v", deleted)
	}
	mismatch := mapConversationAttachError(&conversation.Error{
		Status: http.StatusConflict, Reason: conversation.ReasonMessageTaskMismatch, Message: "这条消息已经换了任务，不能再写入这次结果",
	})
	if !errors.As(mismatch, &bindErr) || bindErr.Reason != "message_task_mismatch" {
		t.Fatalf("mismatch = %#v", mismatch)
	}
	stale := mapConversationAttachError(&conversation.Error{
		Status: http.StatusConflict, Reason: conversation.ReasonConflict, Message: "对话已更新，当前草稿未覆盖已保存内容",
	})
	if !errors.As(stale, &bindErr) || bindErr.Reason != "stale_revision" {
		t.Fatalf("stale = %#v", stale)
	}
	if mapped := mapConversationAttachError(errors.New("对话已更新，当前草稿未覆盖已保存内容")); mapped.Error() != "对话已更新，当前草稿未覆盖已保存内容" {
		t.Fatalf("untyped text must pass through: %v", mapped)
	}
}
