package operations_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	localtask "infinite-canvas/backend/internal/task"

	"gorm.io/gorm"
)

func TestCanvasTaskBindAppliesReceiptInSameTransaction(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyCanvasImageTask(t, "task-bind-ok", "node-bind", "镜头原名", 11, 22)
	pending := h.node(t, "node-bind")
	nodeMeta(pending)["taskStage"] = "delivery_timed_out"
	h.replaceNode(t, "node-bind", pending)
	beforeAssets := h.count(t, &model.Asset{})
	if beforeAssets != 1 {
		t.Fatalf("delivery should persist the asset before bind, got %d", beforeAssets)
	}
	result, err := h.bindTask(t, task.ID, "node-bind", 0)
	if err != nil {
		t.Fatal(err)
	}
	if result.Replayed || result.OpID != localtask.AttachNodeEffectKey(task.ID, "node-bind", 0) {
		t.Fatalf("bind envelope = %#v", result)
	}
	payload, _ := result.Result.(map[string]any)
	if status, _ := payload["bindingStatus"].(string); status != "bound" {
		t.Fatalf("first bind bindingStatus = %#v", payload["bindingStatus"])
	}
	if payload["canvas"] == nil {
		t.Fatal("first bind missing canonical canvas")
	}
	node := h.node(t, "node-bind")
	if title, _ := node["title"].(string); title != "镜头原名" {
		t.Fatalf("title overwritten: %#v", node)
	}
	position, _ := node["position"].(map[string]any)
	if position["x"] != float64(11) || position["y"] != float64(22) {
		t.Fatalf("position overwritten: %#v", position)
	}
	meta := nodeMeta(node)
	if meta["taskStage"] != nil {
		t.Fatalf("completed bind kept stale stage: %#v", meta["taskStage"])
	}
	if meta["status"] != "success" || meta["assetId"] != localtask.MaterializedAssetID(task.ID, 0) {
		t.Fatalf("bound metadata = %#v", meta)
	}
	if h.count(t, &model.Asset{}) != beforeAssets {
		t.Fatal("bind created a second asset")
	}
	if h.receiptCount(t, localtask.AttachNodeEffectKey(task.ID, "node-bind", 0)) != 1 {
		t.Fatal("missing bind receipt")
	}
}

func TestCanvasTaskBindReplayReturnsCurrentProjection(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyCanvasImageTask(t, "task-bind-replay", "node-replay", "原标题", 1, 1)
	first, err := h.bindTask(t, task.ID, "node-replay", 0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.execute(t, operations.ManualCaller(false), "canvas.node.update", "rename-after-bind", map[string]any{
		"canvasId": h.canvasID, "nodeId": "node-replay", "expectedRevision": first.Revision,
		"patch": map[string]any{"title": "绑定后改名"},
	})
	if err != nil {
		t.Fatal(err)
	}
	moved := h.node(t, "node-replay")
	moved["position"] = map[string]any{"x": 90.0, "y": 70.0}
	h.replaceNode(t, "node-replay", moved)

	replay, err := h.bindTask(t, task.ID, "node-replay", 0)
	if err != nil || !replay.Replayed {
		t.Fatalf("replay = %#v err=%v", replay, err)
	}
	payload, _ := replay.Result.(map[string]any)
	node, _ := payload["node"].(map[string]any)
	if title, _ := node["title"].(string); title != "绑定后改名" {
		t.Fatalf("replay projection title = %#v", node)
	}
	position, _ := node["position"].(map[string]any)
	if position["x"] != float64(90) || position["y"] != float64(70) {
		t.Fatalf("replay projection position = %#v", position)
	}
	if h.receiptCount(t, localtask.AttachNodeEffectKey(task.ID, "node-replay", 0)) != 1 {
		t.Fatal("replay wrote a second receipt")
	}
	if h.count(t, &model.Asset{}) != 1 {
		t.Fatal("replay duplicated the asset")
	}
	if status, _ := payload["bindingStatus"].(string); status != "bound" {
		t.Fatalf("replay bindingStatus = %#v", payload["bindingStatus"])
	}
}

func TestCanvasTaskBindReplayIgnoresJSONKeyOrder(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyCanvasImageTask(t, "task-bind-key-order", "node-key-order", "键序", 3, 4)
	first, err := h.bindTask(t, task.ID, "node-key-order", 0)
	if err != nil {
		t.Fatal(err)
	}
	jsParams := frontendBindParams(h.canvasID, task.ID, "node-key-order", 0)
	goParams, err := json.Marshal(map[string]any{
		"canvasId": h.canvasID, "taskId": task.ID, "nodeId": "node-key-order", "outputIndex": 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(jsParams, goParams) {
		t.Fatal("fixture must keep JS insertion order different from encoding/json")
	}
	replay, err := h.executeRaw(t, "canvas.task.bind", localtask.AttachNodeEffectKey(task.ID, "node-key-order", 0), jsParams)
	if err != nil || !replay.Replayed {
		t.Fatalf("key-order replay = %#v err=%v", replay, err)
	}
	if replay.Revision != first.Revision {
		t.Fatalf("key-order replay revision = %d want %d", replay.Revision, first.Revision)
	}
	if h.receiptCount(t, localtask.AttachNodeEffectKey(task.ID, "node-key-order", 0)) != 1 {
		t.Fatal("key-order replay wrote a second receipt")
	}
}

func TestCanvasTaskBindRejectsDifferentCanvasSameEffectKey(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyCanvasImageTask(t, "task-bind-canvas-conflict", "node-canvas-conflict", "冲突", 5, 6)
	if _, err := h.bindTask(t, task.ID, "node-canvas-conflict", 0); err != nil {
		t.Fatal(err)
	}
	_, err := h.executeRaw(t, "canvas.task.bind", localtask.AttachNodeEffectKey(task.ID, "node-canvas-conflict", 0), frontendBindParams("other-canvas", task.ID, "node-canvas-conflict", 0))
	if got := opErr(t, err); got.Reason != "operation_id_reused_with_different_payload" {
		t.Fatalf("different canvasId must conflict, got %v", err)
	}
}

func TestCanvasTaskBindReplayAcceptsLegacyRawPayloadHash(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyCanvasImageTask(t, "task-bind-legacy-hash", "node-legacy-hash", "旧哈希", 7, 8)
	if _, err := h.bindTask(t, task.ID, "node-legacy-hash", 0); err != nil {
		t.Fatal(err)
	}
	jsParams := frontendBindParams(h.canvasID, task.ID, "node-legacy-hash", 0)
	opID := localtask.AttachNodeEffectKey(task.ID, "node-legacy-hash", 0)
	legacyHash := operations.PayloadHash("canvas.task.bind", jsParams)
	if err := h.service.Database().Model(&model.AgentOpRecord{}).
		Where("user_id = ? AND op_id = ?", h.userID, opID).
		Update("payload_hash", legacyHash).Error; err != nil {
		t.Fatal(err)
	}
	replay, err := h.executeRaw(t, "canvas.task.bind", opID, jsParams)
	if err != nil || !replay.Replayed {
		t.Fatalf("legacy raw hash replay = %#v err=%v", replay, err)
	}
	if h.receiptCount(t, opID) != 1 {
		t.Fatal("legacy raw hash replay wrote a second receipt")
	}
}

func TestCanvasTaskBindReplayProjectsReplacedDeletedAndManualEdit(t *testing.T) {
	h := newHarness(t)
	taskA := h.seedReadyCanvasImageTask(t, "task-bind-a", "node-shared", "任务A", 2, 3)
	first, err := h.bindTask(t, taskA.ID, "node-shared", 0)
	if err != nil {
		t.Fatal(err)
	}
	originalContent := h.nodeMetaString(t, "node-shared", "content")
	if originalContent == "" {
		t.Fatal("first bind missing content")
	}

	edited := h.node(t, "node-shared")
	editMeta := nodeMeta(edited)
	editMeta["content"] = "手工改过的旁白"
	edited["metadata"] = editMeta
	h.replaceNode(t, "node-shared", edited)
	sameTaskReplay, err := h.bindTask(t, taskA.ID, "node-shared", 0)
	if err != nil || !sameTaskReplay.Replayed {
		t.Fatalf("same-task replay = %#v err=%v", sameTaskReplay, err)
	}
	samePayload, _ := sameTaskReplay.Result.(map[string]any)
	if status, _ := samePayload["bindingStatus"].(string); status != "bound" {
		t.Fatalf("manual edit bindingStatus = %#v", samePayload["bindingStatus"])
	}
	if content, _ := samePayload["content"].(string); content != "手工改过的旁白" {
		t.Fatalf("manual edit current content = %#v", samePayload["content"])
	}
	historical, _ := samePayload["historical"].(map[string]any)
	if content, _ := historical["content"].(string); content != originalContent {
		t.Fatalf("historical content lost = %#v want %q", historical, originalContent)
	}
	if h.nodeMetaString(t, "node-shared", "content") != "手工改过的旁白" {
		t.Fatal("replay restored the original bind content")
	}

	taskB := h.seedReadyCanvasImageTask(t, "task-bind-b", "node-shared-b", "任务B", 8, 9)
	if _, err := h.bindTask(t, taskB.ID, "node-shared-b", 0); err != nil {
		t.Fatal(err)
	}
	newer := h.node(t, "node-shared")
	newerMeta := nodeMeta(newer)
	bNode := h.node(t, "node-shared-b")
	bMeta := nodeMeta(bNode)
	for _, key := range []string{"taskId", "content", "storageKey", "assetId", "status"} {
		newerMeta[key] = bMeta[key]
	}
	newer["metadata"] = newerMeta
	h.replaceNode(t, "node-shared", newer)
	replacedReplay, err := h.bindTask(t, taskA.ID, "node-shared", 0)
	if err != nil || !replacedReplay.Replayed {
		t.Fatalf("replaced replay = %#v err=%v", replacedReplay, err)
	}
	replacedPayload, _ := replacedReplay.Result.(map[string]any)
	if status, _ := replacedPayload["bindingStatus"].(string); status != "replaced" {
		t.Fatalf("replaced bindingStatus = %#v", replacedPayload["bindingStatus"])
	}
	if _, has := replacedPayload["content"]; has {
		t.Fatalf("replaced replay leaked historical content: %#v", replacedPayload["content"])
	}
	replacedNode, _ := replacedPayload["node"].(map[string]any)
	if nodeMeta(replacedNode)["taskId"] != taskB.ID {
		t.Fatalf("replaced node = %#v", replacedNode)
	}
	if h.nodeMetaString(t, "node-shared", "taskId") != taskB.ID {
		t.Fatal("replaced replay overwrote the newer task node")
	}
	if h.nodeMetaString(t, "node-shared", "content") != h.nodeMetaString(t, "node-shared-b", "content") {
		t.Fatal("replaced replay changed the current generation")
	}
	stored := h.storedReceipt(t, localtask.AttachNodeEffectKey(taskA.ID, "node-shared", 0))
	if content, _ := stored["content"].(string); content != originalContent {
		t.Fatalf("stored historical receipt mutated = %#v", stored)
	}

	h.deleteNode(t, "node-shared")
	deletedReplay, err := h.bindTask(t, taskA.ID, "node-shared", 0)
	if err != nil || !deletedReplay.Replayed {
		t.Fatalf("deleted replay = %#v err=%v", deletedReplay, err)
	}
	deletedPayload, _ := deletedReplay.Result.(map[string]any)
	if status, _ := deletedPayload["bindingStatus"].(string); status != "deleted" {
		t.Fatalf("deleted bindingStatus = %#v", deletedPayload["bindingStatus"])
	}
	if _, has := deletedPayload["node"]; has {
		t.Fatalf("deleted replay still projected a node: %#v", deletedPayload["node"])
	}
	if h.findNode(t, "node-shared") != nil {
		t.Fatal("deleted replay recreated the node")
	}
	if first.Revision <= 0 {
		t.Fatal("first bind missing revision")
	}
}

func TestCanvasTaskBindConcurrentConsumersDoNotDuplicate(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyCanvasImageTask(t, "task-bind-race", "node-race", "并发", 3, 4)
	opID := localtask.AttachNodeEffectKey(task.ID, "node-race", 0)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	results := make(chan operations.Result, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := h.bindTask(t, task.ID, "node-race", 0)
			if err != nil {
				errs <- err
				return
			}
			results <- result
		}()
	}
	wg.Wait()
	close(errs)
	close(results)
	var opErrs int
	for err := range errs {
		if got := operations.AsError(err); got.Reason != "operation_in_progress" {
			t.Fatalf("concurrent bind: %v", err)
		}
		opErrs++
	}
	var applied, replayed int
	for result := range results {
		if result.Replayed {
			replayed++
		} else {
			applied++
		}
	}
	if applied+replayed == 0 {
		t.Fatal("both concurrent consumers failed")
	}
	if h.receiptCount(t, opID) != 1 || h.nodeCount(t) != 3 || h.count(t, &model.Asset{}) != 1 {
		t.Fatalf("duplicate bind state receipts=%d nodes=%d assets=%d in_progress=%d", h.receiptCount(t, opID), h.nodeCount(t), h.count(t, &model.Asset{}), opErrs)
	}
}

func TestCanvasTaskBindRejectsDeletedWrongOwnerAndNewerTaskNode(t *testing.T) {
	h := newHarness(t)
	deleted := h.seedReadyCanvasImageTask(t, "task-deleted", "node-deleted", "将被删除", 1, 1)
	h.deleteNode(t, "node-deleted")
	_, err := h.bindTask(t, deleted.ID, "node-deleted", 0)
	if got := opErr(t, err); got.Reason != "node_deleted" {
		t.Fatalf("deleted node = %v", err)
	}
	if h.findNode(t, "node-deleted") != nil {
		t.Fatal("deleted node was recreated")
	}

	foreign := h.seedReadyCanvasImageTask(t, "task-foreign", "node-foreign", "别人的", 1, 1)
	_, err = h.registry.Execute(operations.Request{
		Op: "canvas.task.bind", OpID: localtask.AttachNodeEffectKey(foreign.ID, "node-foreign", 0),
		UserID: "other-user", Caller: operations.ManualCaller(false),
		Params: bindParams(h.canvasID, foreign.ID, "node-foreign", 0),
	})
	if got := opErr(t, err); got.Code != operations.CodeNotFound && got.Reason != "task_foreign" && got.Reason != "task_not_found" {
		t.Fatalf("wrong owner = %v", err)
	}

	stale := h.seedReadyCanvasImageTask(t, "task-old", "node-stale", "旧任务", 1, 1)
	newer := h.node(t, "node-stale")
	meta := nodeMeta(newer)
	meta["taskId"] = "task-newer"
	newer["metadata"] = meta
	h.replaceNode(t, "node-stale", newer)
	_, err = h.bindTask(t, stale.ID, "node-stale", 0)
	if got := opErr(t, err); got.Reason != "node_task_mismatch" {
		t.Fatalf("newer task node = %v", err)
	}
	evidence, ok := opErr(t, err).Details["canvasBinding"].(map[string]any)
	if !ok || evidence["nodeTaskId"] != "task-newer" || evidence["nodeId"] != "node-stale" || evidence["source"] != "server" {
		t.Fatalf("binding refusal lost the actual server node: %+v", evidence)
	}
	if h.nodeMetaString(t, "node-stale", "taskId") != "task-newer" {
		t.Fatal("stale bind overwrote the newer task node")
	}
}

func TestCanvasTaskBindRejectsClientResultPayload(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyCanvasImageTask(t, "task-client-url", "node-client", "节点", 1, 1)
	_, err := h.execute(t, operations.ManualCaller(false), "canvas.task.bind", localtask.AttachNodeEffectKey(task.ID, "node-client", 0), map[string]any{
		"canvasId": h.canvasID, "taskId": task.ID, "nodeId": "node-client", "outputIndex": 0,
		"resultUrl": "https://example.invalid/paid-retry.png",
	})
	if got := opErr(t, err); got.Reason != "unknown_field" {
		t.Fatalf("client result url = %v", err)
	}
}

func TestCanvasTaskBindTextUsesReceiptTransaction(t *testing.T) {
	h := newHarness(t)
	h.addNode(t, "node-text", "text", "旁白", map[string]any{"taskId": "task-text", "status": "loading", "storyboard": map[string]any{"visibleColumns": []any{"action"}, "referenceNodeIds": []any{"n1"}}})
	now := time.Now()
	task := model.Task{
		ID: "task-text", UserID: h.userID, ProjectID: h.canvasID, Type: "canvas_text",
		Status: model.TaskStatusSucceeded, Operation: "storyboard",
		InputJSON:  `{"metadata":{"source":"canvas","nodeId":"node-text"}}`,
		ResultJSON: `{"text":"成片旁白","rows":[{"shotNumber":1,"action":"开门","id":"shot-keep"}]}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	result, err := h.bindTask(t, task.ID, "node-text", 0)
	if err != nil {
		t.Fatal(err)
	}
	if result.Replayed {
		t.Fatal("text bind should write a receipt")
	}
	meta := h.node(t, "node-text")
	metadata := nodeMeta(meta)
	if metadata["content"] != "成片旁白" || metadata["status"] != "success" {
		t.Fatalf("text node = %#v", metadata)
	}
	board, _ := metadata["storyboard"].(map[string]any)
	if board["visibleColumns"] == nil {
		t.Fatalf("storyboard visible columns dropped: %#v", board)
	}
	if h.receiptCount(t, localtask.AttachNodeEffectKey(task.ID, "node-text", 0)) != 1 {
		t.Fatal("text bind bypassed the receipt transaction")
	}
}

func TestCanvasTaskBindSQLiteFailureBeforePatchLeavesAsset(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyCanvasImageTask(t, "task-fail-patch", "node-fail-patch", "失败前", 1, 1)
	assetID := localtask.MaterializedAssetID(task.ID, 0)
	db := h.service.Database()
	if err := db.Callback().Update().Before("gorm:update").Register("bind_fail_before_patch", func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Name == "CanvasProject" {
			tx.AddError(errors.New("injected canvas patch failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Callback().Update().Remove("bind_fail_before_patch") })
	_, err := h.bindTask(t, task.ID, "node-fail-patch", 0)
	if err == nil {
		t.Fatal("injected patch failure not propagated")
	}
	if h.nodeMetaString(t, "node-fail-patch", "status") == "success" {
		t.Fatal("failed patch still bound the node")
	}
	if h.receiptCount(t, localtask.AttachNodeEffectKey(task.ID, "node-fail-patch", 0)) != 0 {
		t.Fatal("failed patch left a receipt")
	}
	if !h.assetExists(t, assetID) {
		t.Fatal("failed patch consumed the delivered asset")
	}
}

func TestCanvasTaskBindSQLiteFailureAfterPatchRollsBackReceipt(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyCanvasImageTask(t, "task-fail-receipt", "node-fail-receipt", "失败后", 1, 1)
	assetID := localtask.MaterializedAssetID(task.ID, 0)
	db := h.service.Database()
	if err := db.Callback().Update().Before("gorm:update").Register("bind_fail_after_patch", func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Name == "AgentOpRecord" {
			tx.AddError(errors.New("injected receipt failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Callback().Update().Remove("bind_fail_after_patch") })
	_, err := h.bindTask(t, task.ID, "node-fail-receipt", 0)
	if err == nil {
		t.Fatal("injected receipt failure not propagated")
	}
	if h.nodeMetaString(t, "node-fail-receipt", "status") == "success" {
		t.Fatal("rolled-back receipt still left the node bound")
	}
	if h.receiptCount(t, localtask.AttachNodeEffectKey(task.ID, "node-fail-receipt", 0)) != 0 {
		t.Fatal("rolled-back receipt remained")
	}
	if !h.assetExists(t, assetID) {
		t.Fatal("rolled-back receipt consumed the delivered asset")
	}
}

func TestCanvasTaskBindClosedUIAndRestartUseSameOperation(t *testing.T) {
	h := newHarness(t)
	now := time.Now()
	h.addNode(t, "node-bg", "image", "后台绑定", map[string]any{"taskId": "task-bg", "status": "loading"})
	if err := h.service.Database().Create(&model.Resource{
		ID: "res-bg", UserID: h.userID, Kind: "image", Status: model.ResourceStatusReady,
		MimeType: "image/png", Size: 8, Width: 16, Height: 16, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-bg", UserID: h.userID, ProjectID: h.canvasID, Type: "canvas_image",
		Status:     model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"source":"canvas","nodeId":"node-bg"}}`,
		ResultJSON: `{"images":[{"resourceId":"res-bg"}]}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.service.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	if h.nodeMetaString(t, "node-bg", "status") != "success" {
		t.Fatal("closed-UI deliver did not bind the original node")
	}
	if err := h.service.RecoverIncompleteGenerationDeliveries(8); err != nil {
		t.Fatal(err)
	}
	if h.receiptCount(t, localtask.AttachNodeEffectKey(task.ID, "node-bg", 0)) != 1 {
		t.Fatal("restart recovery duplicated the bind receipt")
	}
	if h.count(t, &model.Asset{}) != 1 {
		t.Fatal("restart recovery duplicated the asset")
	}
}

func TestCanvasTaskBindRecoversWhenNodeAppearsAfterDeliver(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyCanvasImageTask(t, "task-later-node", "node-later", "后出现的节点", 5, 6)
	if h.nodeMetaString(t, "node-later", "status") == "success" {
		t.Fatal("deliver without the node must not recreate or bind it")
	}
	if err := h.service.RecoverIncompleteGenerationDeliveries(8); err != nil {
		t.Fatal(err)
	}
	if h.nodeMetaString(t, "node-later", "status") != "success" {
		t.Fatal("restart recovery did not bind the original node after it reappeared")
	}
	if title, _ := h.node(t, "node-later")["title"].(string); title != "后出现的节点" {
		t.Fatal("restart recovery overwrote the manual title")
	}
	if h.receiptCount(t, localtask.AttachNodeEffectKey(task.ID, "node-later", 0)) != 1 {
		t.Fatal("restart recovery duplicated the bind receipt")
	}
	if h.count(t, &model.Asset{}) != 1 {
		t.Fatal("restart recovery duplicated the asset")
	}
}

func TestCanvasTaskBindReplayThrowsOnUnreadableCanvasAndKeepsReceipt(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyCanvasImageTask(t, "task-unreadable-canvas", "node-unreadable", "损坏投影", 4, 5)
	first, err := h.bindTask(t, task.ID, "node-unreadable", 0)
	if err != nil {
		t.Fatal(err)
	}
	if first.Replayed {
		t.Fatal("first bind should commit a receipt")
	}
	if err := h.service.Database().Model(&model.CanvasProject{}).Where("id = ?", h.canvasID).Update("payload_json", "{").Error; err != nil {
		t.Fatal(err)
	}
	_, err = h.bindTask(t, task.ID, "node-unreadable", 0)
	if err == nil {
		t.Fatal("unreadable canvas must not project as deleted")
	}
	if got := opErr(t, err); got.Reason == "deleted" || got.Reason == "node_deleted" {
		t.Fatalf("read/json failure marked deleted: %v", err)
	}
	if h.receiptCount(t, localtask.AttachNodeEffectKey(task.ID, "node-unreadable", 0)) != 1 {
		t.Fatal("projection failure rolled back the original bind receipt")
	}
	stored := h.storedReceipt(t, localtask.AttachNodeEffectKey(task.ID, "node-unreadable", 0))
	if stored["taskId"] != task.ID {
		t.Fatalf("stored receipt lost: %#v", stored)
	}
}

func TestCanvasTaskBindUnreadableOutputIsNotReady(t *testing.T) {
	h := newHarness(t)
	h.addNode(t, "node-bad", "image", "坏结果", map[string]any{"taskId": "task-bad", "status": "loading"})
	now := time.Now()
	task := model.Task{
		ID: "task-bad", UserID: h.userID, ProjectID: h.canvasID, Type: "canvas_image",
		Status:     model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"nodeId":"node-bad"}}`,
		ResultJSON: `{"images":[{"resourceId":"res-missing"}]}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.service.Database().Create(&model.Result{
		ID: localtask.OutputResultID(task.ID, 0), UserID: h.userID, TaskID: task.ID,
		Kind: localtask.ResultKindGenerationOutput, Payload: "{", CreatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	_, err := h.bindTask(t, task.ID, "node-bad", 0)
	if got := opErr(t, err); got.Reason != "delivery_unreadable" {
		t.Fatalf("corrupt output treated as ready: %v", err)
	}
}

func (h *harness) seedReadyCanvasImageTask(t *testing.T, taskID, nodeID, title string, x, y float64) model.Task {
	t.Helper()
	now := time.Now()
	resourceID := "res-" + taskID
	if err := h.service.Database().Create(&model.Resource{
		ID: resourceID, UserID: h.userID, Kind: "image", Status: model.ResourceStatusReady,
		MimeType: "image/png", Size: 12, Width: 32, Height: 32, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: taskID, UserID: h.userID, ProjectID: h.canvasID, Type: "canvas_image",
		Status:     model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"source":"canvas","nodeId":"` + nodeID + `"}}`,
		ResultJSON: `{"images":[{"resourceId":"` + resourceID + `"}]}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.service.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	h.addNode(t, nodeID, "image", title, map[string]any{"taskId": taskID, "status": "loading", "prompt": "猫"})
	moved := h.node(t, nodeID)
	moved["position"] = map[string]any{"x": x, "y": y}
	h.replaceNode(t, nodeID, moved)
	return task
}

func (h *harness) bindTask(t *testing.T, taskID, nodeID string, outputIndex int) (operations.Result, error) {
	t.Helper()
	return h.execute(t, operations.ManualCaller(false), "canvas.task.bind", localtask.AttachNodeEffectKey(taskID, nodeID, outputIndex), map[string]any{
		"canvasId": h.canvasID, "taskId": taskID, "nodeId": nodeID, "outputIndex": outputIndex,
	})
}

func (h *harness) executeRaw(t *testing.T, op, opID string, params json.RawMessage) (operations.Result, error) {
	t.Helper()
	return h.registry.Execute(operations.Request{
		Op: op, OpID: opID, UserID: h.userID, Caller: operations.ManualCaller(false), Params: params,
	})
}

func frontendBindParams(canvasID, taskID, nodeID string, outputIndex int) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(
		`{"canvasId":%q,"taskId":%q,"nodeId":%q,"outputIndex":%d}`,
		canvasID, taskID, nodeID, outputIndex,
	))
}

func bindParams(canvasID, taskID, nodeID string, outputIndex int) json.RawMessage {
	encoded, _ := json.Marshal(map[string]any{"canvasId": canvasID, "taskId": taskID, "nodeId": nodeID, "outputIndex": outputIndex})
	return encoded
}

func (h *harness) addNode(t *testing.T, id, kind, title string, metadata map[string]any) {
	t.Helper()
	doc := h.document(t)
	nodes, _ := doc["nodes"].([]any)
	nodes = append(nodes, map[string]any{
		"id": id, "type": kind, "title": title,
		"position": map[string]any{"x": 1.0, "y": 1.0},
		"width":    320.0, "height": 220.0, "metadata": metadata,
	})
	doc["nodes"] = nodes
	h.saveDocument(t, doc)
}

func (h *harness) replaceNode(t *testing.T, id string, node map[string]any) {
	t.Helper()
	doc := h.document(t)
	nodes, _ := doc["nodes"].([]any)
	for i, raw := range nodes {
		item, _ := raw.(map[string]any)
		if item["id"] == id {
			nodes[i] = node
		}
	}
	doc["nodes"] = nodes
	h.saveDocument(t, doc)
}

func (h *harness) deleteNode(t *testing.T, id string) {
	t.Helper()
	doc := h.document(t)
	nodes, _ := doc["nodes"].([]any)
	kept := make([]any, 0, len(nodes))
	for _, raw := range nodes {
		item, _ := raw.(map[string]any)
		if item["id"] != id {
			kept = append(kept, raw)
		}
	}
	doc["nodes"] = kept
	h.saveDocument(t, doc)
}

func (h *harness) saveDocument(t *testing.T, doc map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.service.UpsertUserCanvasProject(h.userID, encoded); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) document(t *testing.T) map[string]any {
	t.Helper()
	raw, err := h.service.UserCanvasProject(h.userID, h.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func (h *harness) node(t *testing.T, id string) map[string]any {
	t.Helper()
	node := h.findNode(t, id)
	if node == nil {
		t.Fatalf("missing node %s", id)
	}
	return node
}

func (h *harness) findNode(t *testing.T, id string) map[string]any {
	t.Helper()
	doc := h.document(t)
	nodes, _ := doc["nodes"].([]any)
	for _, raw := range nodes {
		node, _ := raw.(map[string]any)
		if node["id"] == id {
			return node
		}
	}
	return nil
}

func (h *harness) nodeCount(t *testing.T) int {
	t.Helper()
	nodes, _ := h.document(t)["nodes"].([]any)
	return len(nodes)
}

func (h *harness) nodeMetaString(t *testing.T, id, key string) string {
	t.Helper()
	meta := nodeMeta(h.node(t, id))
	value, _ := meta[key].(string)
	return value
}

func nodeMeta(node map[string]any) map[string]any {
	meta, _ := node["metadata"].(map[string]any)
	if meta == nil {
		return map[string]any{}
	}
	return meta
}

func (h *harness) storedReceipt(t *testing.T, opID string) map[string]any {
	t.Helper()
	var record model.AgentOpRecord
	if err := h.service.Database().Where("user_id = ? AND op_id = ?", h.userID, opID).First(&record).Error; err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(record.ResultJSON), &stored); err != nil {
		t.Fatalf("stored receipt: %v", err)
	}
	return stored
}

func (h *harness) receiptCount(t *testing.T, opID string) int64 {
	t.Helper()
	var count int64
	if err := h.service.Database().Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ?", h.userID, opID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count
}

func (h *harness) count(t *testing.T, model any) int64 {
	t.Helper()
	var count int64
	if err := h.service.Database().Model(model).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count
}

func (h *harness) assetExists(t *testing.T, id string) bool {
	t.Helper()
	var count int64
	if err := h.service.Database().Model(&model.Asset{}).Where("id = ?", id).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count == 1
}
