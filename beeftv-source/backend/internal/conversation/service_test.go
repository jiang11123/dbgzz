package conversation_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/conversation"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/repository"
)

func TestConversationKeepsLongTextAndHistoryWithinWorkspaceDocumentBound(t *testing.T) {
	_, _, service := openConversationFixture(t)
	messages := make([]map[string]any, 1001)
	for i := range messages {
		messages[i] = map[string]any{"id": fmt.Sprintf("m-%d", i), "role": "user", "content": "hello"}
	}
	messages[0]["content"] = strings.Repeat("长", 70_000)
	raw, err := json.Marshal(map[string]any{"id": "long-history", "title": "旧对话", "messages": messages})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Put("owner", "long-history", 0, raw); err != nil {
		t.Fatalf("valid legacy history must remain saveable: %v", err)
	}
	tooLarge, err := json.Marshal(map[string]any{"id": "too-large", "messages": []map[string]any{
		{"id": "m-1", "role": "user", "content": strings.Repeat("x", conversation.MaxDocumentBytes)},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Put("owner", "too-large", 0, tooLarge); err == nil {
		t.Fatal("document bound must reject without truncation")
	}
}

func openConversationFixture(t *testing.T) (*gorm.DB, string, *conversation.Service) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "workspace.db")
	db, err := gorm.Open(sqlite.Open(path+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	// Match the desktop's shared SQLite pool before racing service writers.
	if err := database.ConfigurePool(db); err != nil {
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
	svc := conversation.New(conversation.NewStore(repository.New(db)))
	return db, path, svc
}

func reopenConversationFixture(t *testing.T, path string) (*gorm.DB, *conversation.Service) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(path+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.ConfigurePool(db); err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := database.RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	return db, conversation.New(conversation.NewStore(repository.New(db)))
}

func sampleDocument(id, title, messageID, taskID string) json.RawMessage {
	payload := map[string]any{
		"id":        id,
		"title":     title,
		"updatedAt": "2026-10-02T00:00:00.000Z",
		"messages": []any{
			map[string]any{"id": "user-1", "role": "user", "content": "镜头", "mode": "video"},
			map[string]any{
				"id": messageID, "role": "assistant", "mode": "video", "content": "", "status": "pending",
				"taskIds": []any{taskID}, "storageKey": "resource:shot-1",
			},
		},
	}
	raw, _ := json.Marshal(payload)
	return raw
}

func TestPutSurvivesRestart(t *testing.T) {
	_, path, svc := openConversationFixture(t)
	saved, err := svc.Put("local", "conversation-1", 0, sampleDocument("conversation-1", "第一镜", "assistant-1", "task-1"))
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 1 || saved.ID != "conversation-1" {
		t.Fatalf("saved = %+v", saved)
	}
	_, restarted := reopenConversationFixture(t, path)
	loaded, err := restarted.Get("local", "conversation-1")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Revision != 1 {
		t.Fatalf("restart revision = %d", loaded.Revision)
	}
	var doc map[string]any
	if err := json.Unmarshal(loaded.Document, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["title"] != "第一镜" {
		t.Fatalf("restart document = %s", loaded.Document)
	}
}

func TestTwoCASWritersOneConflict(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	if _, err := svc.Put("local", "conversation-cas", 0, sampleDocument("conversation-cas", "原稿", "assistant-1", "task-1")); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]error, 2)
	revisions := make([]int64, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			title := "作者甲"
			if i == 1 {
				title = "作者乙"
			}
			record, err := svc.Put("local", "conversation-cas", 1, sampleDocument("conversation-cas", title, "assistant-1", "task-1"))
			results[i] = err
			if err == nil {
				revisions[i] = record.Revision
			}
		}(i)
	}
	close(start)
	wg.Wait()
	successes := 0
	conflicts := 0
	for i, err := range results {
		if err == nil {
			successes++
			if revisions[i] != 2 {
				t.Fatalf("winner revision = %d", revisions[i])
			}
			continue
		}
		var convErr *conversation.Error
		if !errors.As(err, &convErr) || convErr.Reason != conversation.ReasonConflict {
			t.Fatalf("writer %d error = %v", i, err)
		}
		conflicts++
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d errors=%v", successes, conflicts, results)
	}
	final, err := svc.Get("local", "conversation-cas")
	if err != nil || final.Revision != 2 {
		t.Fatalf("final = %+v err=%v", final, err)
	}
}

func TestInterruptedImportReplaysWithoutOverwrite(t *testing.T) {
	db, _, svc := openConversationFixture(t)
	raw := sampleDocument("conversation-import", "导入", "assistant-1", "task-1")
	injected := errors.New("injected import failure")
	err := db.Transaction(func(tx *gorm.DB) error {
		bound := svc.WithTx(tx)
		if _, importErr := bound.Import("local", "creation-conversations-v1:conversation-import", "", raw); importErr != nil {
			t.Fatal(importErr)
		}
		return injected
	})
	if !errors.Is(err, injected) {
		t.Fatalf("tx error = %v", err)
	}
	if _, err := svc.Get("local", "conversation-import"); err == nil {
		t.Fatal("rolled back import still visible")
	}
	first, err := svc.Import("local", "creation-conversations-v1:conversation-import", "", raw)
	if err != nil || !first.Imported || first.Conversation.Revision != 1 {
		t.Fatalf("first import = %+v err=%v", first, err)
	}
	replay, err := svc.Import("local", "creation-conversations-v1:conversation-import", conversation.DocumentHash(first.Conversation.Document), raw)
	if err != nil || replay.Imported {
		t.Fatalf("replay = %+v err=%v", replay, err)
	}
	changed := sampleDocument("conversation-import", "被覆盖", "assistant-1", "task-1")
	_, hashErr := svc.Import("local", "creation-conversations-v1:conversation-import", "", changed)
	var convErr *conversation.Error
	if !errors.As(hashErr, &convErr) || convErr.Reason != conversation.ReasonConflict {
		t.Fatalf("changed hash error = %v", hashErr)
	}
	loaded, err := svc.Get("local", "conversation-import")
	if err != nil {
		t.Fatal(err)
	}
	if !jsonContains(loaded.Document, `"title":"导入"`) {
		t.Fatalf("import overwritten: %s", loaded.Document)
	}
}

func TestDeletedTombstoneNotResurrectedByLegacyImport(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	if _, err := svc.Put("local", "conversation-dead", 0, sampleDocument("conversation-dead", "旧对话", "assistant-1", "task-1")); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Delete("local", "conversation-dead", 1); err != nil {
		t.Fatal(err)
	}
	list, err := svc.List("local")
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Conversations) != 0 || len(list.DeletedIDs) != 1 || list.DeletedIDs[0] != "conversation-dead" {
		t.Fatalf("list after delete = %+v", list)
	}
	imported, err := svc.Import("local", "creation-conversations-v1:conversation-dead", "", sampleDocument("conversation-dead", "复活", "assistant-1", "task-1"))
	if err != nil {
		t.Fatal(err)
	}
	if imported.Imported || !imported.Deleted {
		t.Fatalf("tombstone resurrected: %+v", imported)
	}
	if _, err := svc.Get("local", "conversation-dead"); err == nil {
		t.Fatal("deleted conversation visible via get")
	}
	if _, err := svc.Put("local", "conversation-dead", 0, sampleDocument("conversation-dead", "复活", "assistant-1", "task-1")); err == nil {
		t.Fatal("put resurrected tombstone")
	}
}

func TestAttachMessageResultRollsBackWithCallerTx(t *testing.T) {
	db, _, svc := openConversationFixture(t)
	saved, err := svc.Put("local", "conversation-attach", 0, sampleDocument("conversation-attach", "待挂载", "assistant-1", "task-1"))
	if err != nil {
		t.Fatal(err)
	}
	injected := errors.New("injected attach failure")
	err = db.Transaction(func(tx *gorm.DB) error {
		if _, attachErr := svc.WithTx(tx).AttachMessageResult("local", conversation.AttachInput{
			ConversationID: "conversation-attach",
			MessageID:      "assistant-1",
			TaskID:         "task-1",
			EffectKey:      "task-1:output:0",
			ResultURLs:     []string{"resource:result-1"},
			Status:         "done",
		}); attachErr != nil {
			t.Fatal(attachErr)
		}
		return injected
	})
	if !errors.Is(err, injected) {
		t.Fatalf("tx error = %v", err)
	}
	loaded, err := svc.Get("local", "conversation-attach")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Revision != saved.Revision || jsonContains(loaded.Document, "resource:result-1") {
		t.Fatalf("attach leaked across rollback: %s", loaded.Document)
	}
	attached, err := svc.AttachMessageResult("local", conversation.AttachInput{
		ConversationID: "conversation-attach",
		MessageID:      "assistant-1",
		TaskID:         "task-1",
		EffectKey:      "task-1:output:0",
		ResultURLs:     []string{"resource:result-1"},
		Status:         "done",
	})
	if err != nil {
		t.Fatal(err)
	}
	if attached.Revision != saved.Revision+1 {
		t.Fatalf("attach revision = %d", attached.Revision)
	}
	replay, err := svc.AttachMessageResult("local", conversation.AttachInput{
		ConversationID: "conversation-attach",
		MessageID:      "assistant-1",
		TaskID:         "task-1",
		EffectKey:      "task-1:output:0",
		ResultURLs:     []string{"resource:result-2"},
		Status:         "done",
	})
	if err != nil {
		t.Fatal(err)
	}
	if replay.Revision != attached.Revision || jsonContains(replay.Document, "resource:result-2") {
		t.Fatalf("effect key was not idempotent: %s", replay.Document)
	}
	if _, err := svc.AttachMessageResult("local", conversation.AttachInput{
		ConversationID: "conversation-attach",
		MessageID:      "assistant-1",
		TaskID:         "task-other",
		ResultURLs:     []string{"resource:result-3"},
	}); err == nil {
		t.Fatal("attached result for unrelated task")
	}
	if jsonContains(replay.Document, `"title":"改名"`) {
		t.Fatal("attach changed title")
	}
}

func TestAttachMessageResultTypedReasons(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	if _, err := svc.Put("local", "conversation-typed", 0, sampleDocument("conversation-typed", "待挂载", "assistant-1", "task-1")); err != nil {
		t.Fatal(err)
	}
	_, err := svc.AttachMessageResult("local", conversation.AttachInput{
		ConversationID: "conversation-typed",
		MessageID:      "assistant-1",
		TaskID:         "task-other",
		ResultURLs:     []string{"resource:result-3"},
	})
	var convErr *conversation.Error
	if !errors.As(err, &convErr) || convErr.Reason != conversation.ReasonMessageTaskMismatch {
		t.Fatalf("task mismatch = %v", err)
	}
	if _, err := svc.Delete("local", "conversation-typed", 1); err != nil {
		t.Fatal(err)
	}
	_, err = svc.AttachMessageResult("local", conversation.AttachInput{
		ConversationID: "conversation-typed",
		MessageID:      "assistant-1",
		TaskID:         "task-1",
		ResultURLs:     []string{"resource:result-1"},
	})
	if !errors.As(err, &convErr) || convErr.Reason != conversation.ReasonDeleted {
		t.Fatalf("deleted attach = %v", err)
	}
}

func TestPutRejectsCredentialsAndKeepsUnknownFields(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	_, err := svc.Put("local", "conversation-secret", 0, json.RawMessage(`{"id":"conversation-secret","title":"x","messages":[],"apiKey":"sk-test"}`))
	var convErr *conversation.Error
	if !errors.As(err, &convErr) || convErr.Reason != conversation.ReasonInvalid {
		t.Fatalf("credential error = %v", err)
	}
	raw := json.RawMessage(`{"id":"conversation-keep","title":"保留","futureField":true,"messages":[{"id":"m1","role":"user","content":"data: keep the prompt","unknownLocator":"resource:keep","dataUrl":"data:image/png;base64,aaaa","attachments":[{"id":"a1","storageKey":"resource:shot-1","dataUrl":"data:image/png;base64,aaaa"}]}]}`)
	saved, err := svc.Put("local", "conversation-keep", 0, raw)
	if err != nil {
		t.Fatal(err)
	}
	if jsonContains(saved.Document, "data:image") || jsonContains(saved.Document, "sk-test") {
		t.Fatalf("blob or credential stored: %s", saved.Document)
	}
	if !jsonContains(saved.Document, `"futureField":true`) || !jsonContains(saved.Document, `"unknownLocator":"resource:keep"`) {
		t.Fatalf("unknown fields dropped: %s", saved.Document)
	}
}

func TestDeleteDoesNotRequireMissingLocalDraft(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	deleted, err := svc.Delete("local", "conversation-never", 0)
	if err != nil || !deleted.Deleted {
		t.Fatalf("missing local delete = %+v err=%v", deleted, err)
	}
	imported, err := svc.Import("local", "creation-conversations-v1:conversation-never", "", sampleDocument("conversation-never", "复活", "assistant-1", "task-1"))
	if err != nil || imported.Imported || !imported.Deleted {
		t.Fatalf("zero-revision tombstone missing: %+v err=%v", imported, err)
	}
}

func TestDeleteZeroRevisionDoesNotDeleteExisting(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	if _, err := svc.Put("local", "conversation-live", 0, sampleDocument("conversation-live", "在用", "assistant-1", "task-1")); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Delete("local", "conversation-live", 0)
	var convErr *conversation.Error
	if !errors.As(err, &convErr) || convErr.Reason != conversation.ReasonConflict {
		t.Fatalf("zero revision delete = %v", err)
	}
	loaded, err := svc.Get("local", "conversation-live")
	if err != nil || loaded.Revision != 1 {
		t.Fatalf("existing row deleted by revision 0: %+v err=%v", loaded, err)
	}
}

func TestPutReplayAfterLostAckIsIdempotent(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	raw := sampleDocument("conversation-replay", "原稿", "assistant-1", "task-1")
	first, err := svc.Put("local", "conversation-replay", 0, raw)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := svc.Put("local", "conversation-replay", 0, raw)
	if err != nil || replay.Revision != first.Revision {
		t.Fatalf("lost-ack replay = %+v err=%v", replay, err)
	}
	next := sampleDocument("conversation-replay", "改名", "assistant-1", "task-1")
	_, err = svc.Put("local", "conversation-replay", 0, next)
	var convErr *conversation.Error
	if !errors.As(err, &convErr) || convErr.Reason != conversation.ReasonConflict {
		t.Fatalf("different document replay = %v", err)
	}
}

func TestPutFillsMissingTitle(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	saved, err := svc.Put("local", "conversation-title", 0, json.RawMessage(`{"id":"conversation-title","messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(saved.Document, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["title"] != "新创作" {
		t.Fatalf("missing title = %s", saved.Document)
	}
	blank, err := svc.Put("local", "conversation-blank", 0, json.RawMessage(`{"id":"conversation-blank","title":"  ","messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(blank.Document, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["title"] != "新创作" {
		t.Fatalf("blank title = %s", blank.Document)
	}
}

func TestNormalizeKeepsPromptTextAndRejectsNumericIDs(t *testing.T) {
	_, _, svc := openConversationFixture(t)
	raw := json.RawMessage(`{"id":"conversation-text","title":"保留","messages":[{"id":"m1","role":"user","mode":"video","content":"data: this is a URI scheme note","unknownLocator":"resource:keep"}]}`)
	saved, err := svc.Put("local", "conversation-text", 0, raw)
	if err != nil {
		t.Fatal(err)
	}
	if !jsonContains(saved.Document, `"content":"data: this is a URI scheme note"`) || !jsonContains(saved.Document, `"unknownLocator":"resource:keep"`) {
		t.Fatalf("prompt or unknown field dropped: %s", saved.Document)
	}
	_, err = svc.Put("local", "conversation-number", 0, json.RawMessage(`{"id":123,"title":"x","messages":[]}`))
	var convErr *conversation.Error
	if !errors.As(err, &convErr) || convErr.Reason != conversation.ReasonInvalid {
		t.Fatalf("numeric id error = %v", err)
	}
	_, err = svc.Put("local", "conversation-blob-only", 0, json.RawMessage(`{"id":"conversation-blob-only","title":"x","messages":[{"id":"m1","role":"user","content":"hi","attachments":[{"id":"a1","dataUrl":"data:image/png;base64,aaaa"}]}]}`))
	if !errors.As(err, &convErr) || convErr.Reason != conversation.ReasonInvalid {
		t.Fatalf("blob-only attachment error = %v", err)
	}
}

func TestConcurrentImportSameOperationDifferentDocuments(t *testing.T) {
	db, _, svc := openConversationFixture(t)
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			id := "conversation-import-a"
			title := "甲"
			if i == 1 {
				id = "conversation-import-b"
				title = "乙"
			}
			_, results[i] = svc.Import("local", "creation-conversations-v1:shared-op", "", sampleDocument(id, title, "assistant-1", "task-1"))
		}(i)
	}
	close(start)
	wg.Wait()
	successes := 0
	conflicts := 0
	for _, err := range results {
		if err == nil {
			successes++
			continue
		}
		var convErr *conversation.Error
		if !errors.As(err, &convErr) || convErr.Reason != conversation.ReasonConflict {
			t.Fatalf("import error = %v", err)
		}
		conflicts++
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d errors=%v", successes, conflicts, results)
	}
	var count int64
	if err := db.Raw("SELECT COUNT(*) FROM creation_conversations WHERE import_operation_id = ?", "creation-conversations-v1:shared-op").Scan(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("duplicate import rows = %d", count)
	}
}

func jsonContains(raw json.RawMessage, fragment string) bool {
	return strings.Contains(string(raw), fragment)
}
