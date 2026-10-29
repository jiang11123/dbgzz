package operations_test

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/conversation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"

	"gorm.io/gorm"
)

func TestConversationMessageAttachAppliesReceiptInSameTransaction(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyMessageImageTask(t, "task-msg-ok", "conv-ok", "msg-ok")
	beforeAssets := h.count(t, &model.Asset{})
	result, err := h.attachMessage(t, "conv-ok", task.ID, "msg-ok", 0)
	if err != nil {
		t.Fatal(err)
	}
	if result.Replayed || result.OpID != localtask.AttachMessageEffectKey(task.ID, "msg-ok", 0) {
		t.Fatalf("attach envelope = %#v", result)
	}
	payload, _ := result.Result.(map[string]any)
	if status, _ := payload["bindingStatus"].(string); status != "bound" {
		t.Fatalf("first attach bindingStatus = %#v", payload["bindingStatus"])
	}
	if payload["conversation"] == nil || payload["message"] == nil {
		t.Fatal("first attach missing canonical conversation")
	}
	if content, _ := payload["content"].(string); content != "图片已生成" {
		t.Fatalf("media content = %#v", payload["content"])
	}
	message := h.conversationMessage(t, "conv-ok", "msg-ok")
	if status, _ := message["status"].(string); status != "done" {
		t.Fatalf("message status = %#v", message)
	}
	if h.count(t, &model.Asset{}) != beforeAssets {
		t.Fatal("attach created a second asset")
	}
	if h.receiptCount(t, localtask.AttachMessageEffectKey(task.ID, "msg-ok", 0)) != 1 {
		t.Fatal("missing attach receipt")
	}
}

func TestConversationMessageAttachTextUsesReceiptTransaction(t *testing.T) {
	h := newHarness(t)
	h.seedConversation(t, "conv-text", "msg-text", "task-text")
	now := time.Now()
	task := model.Task{
		ID: "task-text", UserID: h.userID, Type: "text", Status: model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"source":"create-page","conversationId":"conv-text","messageId":"msg-text"}}`,
		ResultJSON: `{"text":"成片旁白"}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	result, err := h.attachMessage(t, "conv-text", task.ID, "msg-text", 0)
	if err != nil {
		t.Fatal(err)
	}
	if result.Replayed {
		t.Fatal("text attach should write a receipt")
	}
	payload, _ := result.Result.(map[string]any)
	if content, _ := payload["content"].(string); content != "成片旁白" {
		t.Fatalf("text content = %#v", payload["content"])
	}
	message := h.conversationMessage(t, "conv-text", "msg-text")
	if content, _ := message["content"].(string); content != "成片旁白" {
		t.Fatalf("stored text = %#v", message)
	}
	if h.receiptCount(t, localtask.AttachMessageEffectKey(task.ID, "msg-text", 0)) != 1 {
		t.Fatal("text attach bypassed the receipt transaction")
	}
}

func TestConversationMessageAttachReplayProjectsReplacedDeletedAndKeepsHistorical(t *testing.T) {
	h := newHarness(t)
	taskA := h.seedReadyMessageImageTask(t, "task-msg-a", "conv-shared", "msg-shared")
	first, err := h.attachMessage(t, "conv-shared", taskA.ID, "msg-shared", 0)
	if err != nil {
		t.Fatal(err)
	}
	originalContent, _ := first.Result.(map[string]any)
	originalText, _ := originalContent["content"].(string)
	if originalText == "" {
		t.Fatal("first attach missing content")
	}

	h.replaceMessageTaskIDs(t, "conv-shared", "msg-shared", []string{"task-msg-b"})
	replaced, err := h.attachMessage(t, "conv-shared", taskA.ID, "msg-shared", 0)
	if err != nil || !replaced.Replayed {
		t.Fatalf("replaced replay = %#v err=%v", replaced, err)
	}
	replacedPayload, _ := replaced.Result.(map[string]any)
	if status, _ := replacedPayload["bindingStatus"].(string); status != "replaced" {
		t.Fatalf("replaced bindingStatus = %#v", replacedPayload["bindingStatus"])
	}
	if _, has := replacedPayload["content"]; has {
		t.Fatalf("replaced replay leaked historical content: %#v", replacedPayload["content"])
	}
	if ids := h.messageTaskIDs(t, "conv-shared", "msg-shared"); len(ids) != 1 || ids[0] != "task-msg-b" {
		t.Fatalf("replaced replay overwrote current taskIds = %#v", ids)
	}
	stored := h.storedReceipt(t, localtask.AttachMessageEffectKey(taskA.ID, "msg-shared", 0))
	if content, _ := stored["content"].(string); content != originalText {
		t.Fatalf("stored historical receipt mutated = %#v", stored)
	}

	h.deleteConversationMessage(t, "conv-shared", "msg-shared")
	deletedMessage, err := h.attachMessage(t, "conv-shared", taskA.ID, "msg-shared", 0)
	if err != nil || !deletedMessage.Replayed {
		t.Fatalf("deleted message replay = %#v err=%v", deletedMessage, err)
	}
	deletedPayload, _ := deletedMessage.Result.(map[string]any)
	if status, _ := deletedPayload["bindingStatus"].(string); status != "deleted" {
		t.Fatalf("deleted message bindingStatus = %#v", deletedPayload["bindingStatus"])
	}
	if _, has := deletedPayload["message"]; has {
		t.Fatalf("deleted replay still projected a message: %#v", deletedPayload["message"])
	}
	if h.findConversationMessage(t, "conv-shared", "msg-shared") != nil {
		t.Fatal("deleted replay resurrected the message")
	}

	if _, err := h.conversations().Delete(h.userID, "conv-shared", h.conversationRevision(t, "conv-shared")); err != nil {
		t.Fatal(err)
	}
	deletedConv, err := h.attachMessage(t, "conv-shared", taskA.ID, "msg-shared", 0)
	if err != nil || !deletedConv.Replayed {
		t.Fatalf("deleted conversation replay = %#v err=%v", deletedConv, err)
	}
	deletedConvPayload, _ := deletedConv.Result.(map[string]any)
	if status, _ := deletedConvPayload["bindingStatus"].(string); status != "deleted" {
		t.Fatalf("deleted conversation bindingStatus = %#v", deletedConvPayload["bindingStatus"])
	}
	if h.receiptCount(t, localtask.AttachMessageEffectKey(taskA.ID, "msg-shared", 0)) != 1 {
		t.Fatal("replay wrote a second receipt")
	}
}

func TestConversationMessageAttachRejectsClientResultPayloadAndFailedTask(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyMessageImageTask(t, "task-client-url", "conv-client", "msg-client")
	_, err := h.execute(t, operations.ManualCaller(false), "conversation.message.attach", localtask.AttachMessageEffectKey(task.ID, "msg-client", 0), map[string]any{
		"conversationId": "conv-client", "taskId": task.ID, "messageId": "msg-client", "outputIndex": 0,
		"resultUrls": []string{"https://example.invalid/paid-retry.png"},
	})
	if got := opErr(t, err); got.Reason != "unknown_field" {
		t.Fatalf("client result urls = %v", err)
	}

	now := time.Now()
	failed := model.Task{
		ID: "task-failed-msg", UserID: h.userID, Type: "text", Status: model.TaskStatusFailed,
		InputJSON:  `{"metadata":{"conversationId":"conv-client","messageId":"msg-client"}}`,
		ResultJSON: `{"text":"不该写入"}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := h.service.Database().Create(&failed).Error; err != nil {
		t.Fatal(err)
	}
	_, err = h.attachMessage(t, "conv-client", failed.ID, "msg-client", 0)
	if got := opErr(t, err); got.Reason != "task_not_succeeded" {
		t.Fatalf("failed task attach = %v", err)
	}
	message := h.conversationMessage(t, "conv-client", "msg-client")
	if content, _ := message["content"].(string); content == "不该写入" {
		t.Fatal("failed task wrote message content")
	}
}

func TestConversationMessageAttachConcurrentConsumersDoNotDuplicate(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyMessageImageTask(t, "task-msg-race", "conv-race", "msg-race")
	opID := localtask.AttachMessageEffectKey(task.ID, "msg-race", 0)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	results := make(chan operations.Result, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := h.attachMessage(t, "conv-race", task.ID, "msg-race", 0)
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
			t.Fatalf("concurrent attach: %v", err)
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
	if h.receiptCount(t, opID) != 1 {
		t.Fatalf("duplicate attach receipts=%d in_progress=%d", h.receiptCount(t, opID), opErrs)
	}
}

func TestConversationMessageAttachSQLiteFailureBeforePatchLeavesAsset(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyMessageImageTask(t, "task-fail-msg-patch", "conv-fail-patch", "msg-fail-patch")
	assetID := localtask.MaterializedAssetID(task.ID, 0)
	db := h.service.Database()
	if err := db.Callback().Update().Before("gorm:update").Register("msg_fail_before_patch", func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Name == "CreationConversation" {
			tx.AddError(errors.New("injected conversation patch failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Callback().Update().Remove("msg_fail_before_patch") })
	_, err := h.attachMessage(t, "conv-fail-patch", task.ID, "msg-fail-patch", 0)
	if err == nil {
		t.Fatal("injected patch failure not propagated")
	}
	message := h.conversationMessage(t, "conv-fail-patch", "msg-fail-patch")
	if status, _ := message["status"].(string); status == "done" {
		t.Fatal("failed patch still bound the message")
	}
	if h.receiptCount(t, localtask.AttachMessageEffectKey(task.ID, "msg-fail-patch", 0)) != 0 {
		t.Fatal("failed patch left a receipt")
	}
	if !h.assetExists(t, assetID) {
		t.Fatal("failed patch consumed the delivered asset")
	}
}

func TestConversationMessageAttachSQLiteFailureAfterPatchRollsBackReceipt(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyMessageImageTask(t, "task-fail-msg-receipt", "conv-fail-receipt", "msg-fail-receipt")
	assetID := localtask.MaterializedAssetID(task.ID, 0)
	db := h.service.Database()
	if err := db.Callback().Update().Before("gorm:update").Register("msg_fail_after_patch", func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Name == "AgentOpRecord" {
			tx.AddError(errors.New("injected receipt failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Callback().Update().Remove("msg_fail_after_patch") })
	_, err := h.attachMessage(t, "conv-fail-receipt", task.ID, "msg-fail-receipt", 0)
	if err == nil {
		t.Fatal("injected receipt failure not propagated")
	}
	message := h.conversationMessage(t, "conv-fail-receipt", "msg-fail-receipt")
	if status, _ := message["status"].(string); status == "done" {
		t.Fatal("rolled-back receipt still left the message bound")
	}
	if h.receiptCount(t, localtask.AttachMessageEffectKey(task.ID, "msg-fail-receipt", 0)) != 0 {
		t.Fatal("rolled-back receipt remained")
	}
	if !h.assetExists(t, assetID) {
		t.Fatal("rolled-back receipt consumed the delivered asset")
	}
}

func TestConversationMessageAttachClosedUIAndRestartUseSameOperation(t *testing.T) {
	h := newHarness(t)
	h.seedConversation(t, "conv-bg", "msg-bg", "task-bg")
	now := time.Now()
	if err := h.service.Database().Create(&model.Resource{
		ID: "res-msg-bg", UserID: h.userID, Kind: "image", Status: model.ResourceStatusReady,
		MimeType: "image/png", Size: 8, Width: 16, Height: 16, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-bg", UserID: h.userID, Type: "canvas_image",
		Status:     model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"source":"create-page","conversationId":"conv-bg","messageId":"msg-bg"}}`,
		ResultJSON: `{"images":[{"resourceId":"res-msg-bg"}]}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.service.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	message := h.conversationMessage(t, "conv-bg", "msg-bg")
	if status, _ := message["status"].(string); status != "done" {
		t.Fatalf("closed-UI deliver did not attach the original message: %#v", message)
	}
	if err := h.service.RecoverIncompleteGenerationDeliveries(8); err != nil {
		t.Fatal(err)
	}
	if h.receiptCount(t, localtask.AttachMessageEffectKey(task.ID, "msg-bg", 0)) != 1 {
		t.Fatal("restart recovery duplicated the attach receipt")
	}
	if h.count(t, &model.Asset{}) != 1 {
		t.Fatal("restart recovery duplicated the asset")
	}
}

func TestConversationMessageAttachReplayThrowsOnUnreadableDocumentAndKeepsReceipt(t *testing.T) {
	h := newHarness(t)
	task := h.seedReadyMessageImageTask(t, "task-unreadable-msg", "conv-unreadable", "msg-unreadable")
	if _, err := h.attachMessage(t, "conv-unreadable", task.ID, "msg-unreadable", 0); err != nil {
		t.Fatal(err)
	}
	if err := h.service.Database().Model(&model.CreationConversation{}).
		Where("user_id = ? AND conversation_id = ?", h.userID, "conv-unreadable").
		Update("document", "{").Error; err != nil {
		t.Fatal(err)
	}
	_, err := h.attachMessage(t, "conv-unreadable", task.ID, "msg-unreadable", 0)
	if err == nil {
		t.Fatal("unreadable conversation must not project as deleted")
	}
	if got := opErr(t, err); got.Reason == "deleted" || got.Reason == "conversation_deleted" {
		t.Fatalf("read/json failure marked deleted: %v", err)
	}
	if h.receiptCount(t, localtask.AttachMessageEffectKey(task.ID, "msg-unreadable", 0)) != 1 {
		t.Fatal("projection failure rolled back the original attach receipt")
	}
}

func (h *harness) conversations() *conversation.Service {
	return conversation.New(conversation.NewStore(repository.New(h.service.Database())))
}

func (h *harness) seedConversation(t *testing.T, conversationID, messageID, taskID string) {
	t.Helper()
	payload := map[string]any{
		"id":        conversationID,
		"title":     "创作对话",
		"updatedAt": "2026-10-02T00:00:00.000Z",
		"messages": []any{
			map[string]any{"id": "user-1", "role": "user", "content": "镜头", "mode": "image"},
			map[string]any{
				"id": messageID, "role": "assistant", "mode": "image", "content": "", "status": "pending",
				"taskIds": []any{taskID},
			},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.conversations().Put(h.userID, conversationID, 0, raw); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) seedReadyMessageImageTask(t *testing.T, taskID, conversationID, messageID string) model.Task {
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
		ID: taskID, UserID: h.userID, Type: "canvas_image",
		Status:     model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"source":"create-page","conversationId":"` + conversationID + `","messageId":"` + messageID + `"}}`,
		ResultJSON: `{"images":[{"resourceId":"` + resourceID + `"}]}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.service.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	h.seedConversation(t, conversationID, messageID, taskID)
	return task
}

func (h *harness) attachMessage(t *testing.T, conversationID, taskID, messageID string, outputIndex int) (operations.Result, error) {
	t.Helper()
	return h.execute(t, operations.ManualCaller(false), "conversation.message.attach", localtask.AttachMessageEffectKey(taskID, messageID, outputIndex), map[string]any{
		"conversationId": conversationID, "taskId": taskID, "messageId": messageID, "outputIndex": outputIndex,
	})
}

func (h *harness) conversationDocument(t *testing.T, conversationID string) map[string]any {
	t.Helper()
	record, err := h.conversations().Get(h.userID, conversationID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(record.Document, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func (h *harness) conversationRevision(t *testing.T, conversationID string) int64 {
	t.Helper()
	record, err := h.conversations().Get(h.userID, conversationID)
	if err != nil {
		t.Fatal(err)
	}
	return record.Revision
}

func (h *harness) conversationMessage(t *testing.T, conversationID, messageID string) map[string]any {
	t.Helper()
	message := h.findConversationMessage(t, conversationID, messageID)
	if message == nil {
		t.Fatalf("message %s missing", messageID)
	}
	return message
}

func (h *harness) findConversationMessage(t *testing.T, conversationID, messageID string) map[string]any {
	t.Helper()
	doc := h.conversationDocument(t, conversationID)
	messages, _ := doc["messages"].([]any)
	for _, raw := range messages {
		message, _ := raw.(map[string]any)
		if message == nil {
			continue
		}
		if id, _ := message["id"].(string); id == messageID {
			return message
		}
	}
	return nil
}

func (h *harness) messageTaskIDs(t *testing.T, conversationID, messageID string) []string {
	t.Helper()
	message := h.conversationMessage(t, conversationID, messageID)
	raw, _ := message["taskIds"].([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		text, _ := item.(string)
		if text != "" {
			out = append(out, text)
		}
	}
	return out
}

func (h *harness) replaceMessageTaskIDs(t *testing.T, conversationID, messageID string, taskIDs []string) {
	t.Helper()
	record, err := h.conversations().Get(h.userID, conversationID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(record.Document, &doc); err != nil {
		t.Fatal(err)
	}
	messages, _ := doc["messages"].([]any)
	ids := make([]any, 0, len(taskIDs))
	for _, id := range taskIDs {
		ids = append(ids, id)
	}
	for _, raw := range messages {
		message, _ := raw.(map[string]any)
		if message == nil {
			continue
		}
		if id, _ := message["id"].(string); id == messageID {
			message["taskIds"] = ids
		}
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.conversations().Put(h.userID, conversationID, record.Revision, encoded); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) deleteConversationMessage(t *testing.T, conversationID, messageID string) {
	t.Helper()
	record, err := h.conversations().Get(h.userID, conversationID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(record.Document, &doc); err != nil {
		t.Fatal(err)
	}
	messages, _ := doc["messages"].([]any)
	next := make([]any, 0, len(messages))
	for _, raw := range messages {
		message, _ := raw.(map[string]any)
		if message == nil {
			continue
		}
		if id, _ := message["id"].(string); id == messageID {
			continue
		}
		next = append(next, raw)
	}
	doc["messages"] = next
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.conversations().Put(h.userID, conversationID, record.Revision, encoded); err != nil {
		t.Fatal(err)
	}
}
