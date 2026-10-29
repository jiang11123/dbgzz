package textreplay

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type testLog struct {
	mu       sync.Mutex
	messages []string
}

func (l *testLog) Log(_, _, _, message, _ string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.messages = append(l.messages, message)
	return nil
}

func openReplay(t *testing.T) (*gorm.DB, *Service) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "replay.db")+"?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.Task{}, &model.TaskTextDelta{}); err != nil {
		t.Fatal(err)
	}
	return db, New(NewStore(repository.New(db)), Dependencies{Logger: &testLog{}})
}

func createTask(t *testing.T, db *gorm.DB, id, user, taskType string, status model.TaskStatus) {
	t.Helper()
	task := model.Task{ID: id, UserID: user, Type: taskType, Status: status, Stage: "文本持久化（前端自管）", Progress: 5}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
}

func authMessage(err error) string {
	var appErr *kernel.AppError
	if errors.As(err, &appErr) {
		return appErr.Message
	}
	return ""
}

func TestIsRequest(t *testing.T) {
	cases := []struct {
		name  string
		input map[string]any
		want  bool
	}{
		{"replay 布尔 true", map[string]any{"replay": true}, true},
		{"replay 字符串 true", map[string]any{"replay": "true"}, true},
		{"replay 字符串 True 大小写", map[string]any{"replay": "TRUE"}, true},
		{"replay 布尔 false", map[string]any{"replay": false}, false},
		{"无 replay 字段", map[string]any{"mode": "text"}, false},
		{"replay 空字符串", map[string]any{"replay": ""}, false},
		{"replay 数字", map[string]any{"replay": 1}, false},
		{"replay nil", map[string]any{"replay": nil}, false},
		{"nil input", nil, false},
	}
	for _, tc := range cases {
		if got := IsRequest(tc.input); got != tc.want {
			t.Errorf("%s: IsRequest(%v) = %v, want %v", tc.name, tc.input, got, tc.want)
		}
	}
}

func TestAppendRejectsForeignOwnerAndNonText(t *testing.T) {
	db, svc := openReplay(t)
	createTask(t, db, "text-1", "owner", "canvas_text", model.TaskStatusTextReplay)
	createTask(t, db, "image-1", "owner", "canvas_image", model.TaskStatusRunning)

	if _, err := svc.Append("other", "text-1", "hello"); err == nil {
		t.Fatal("foreign owner must not append")
	}
	if _, err := svc.Append("owner", "image-1", "hello"); authMessage(err) != "只有文本生成任务支持增量回放" {
		t.Fatalf("non-text append: %v", err)
	}
	if _, err := svc.Append("owner", "text-1", "   "); authMessage(err) != "文本增量不能为空" {
		t.Fatalf("empty append: %v", err)
	}
	if _, err := svc.Append("owner", "text-1", strings.Repeat("x", MaxEventBytes+1)); authMessage(err) != "单条文本增量不能超过 64KB" {
		t.Fatalf("oversize event: %v", err)
	}
	item, err := svc.Append("owner", "text-1", "第一段")
	if err != nil || item.Sequence != 1 || item.Content != "第一段" {
		t.Fatalf("append: %#v %v", item, err)
	}
}

func TestAppendAllowsStoryboardAndAgentNames(t *testing.T) {
	db, svc := openReplay(t)
	createTask(t, db, "board", "owner", "storyboard", model.TaskStatusRunning)
	createTask(t, db, "agent", "owner", "cloud_agent_step", model.TaskStatusRunning)
	if _, err := svc.Append("owner", "board", "镜号"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Append("owner", "agent", "步骤"); err != nil {
		t.Fatal(err)
	}
}

func TestCompleteOwnsStatusAndClosesWindow(t *testing.T) {
	db, svc := openReplay(t)
	createTask(t, db, "replay-1", "owner", "text", model.TaskStatusTextReplay)
	if _, err := svc.Append("owner", "replay-1", "hello"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Complete("owner", "replay-1", "   "); authMessage(err) != "文本内容不能为空" {
		t.Fatalf("empty complete: %v", err)
	}
	if _, err := svc.Complete("owner", "replay-1", strings.Repeat("x", MaxTaskBytes+1)); authMessage(err) != "文本内容过大" {
		t.Fatalf("oversize complete: %v", err)
	}
	if _, err := svc.Complete("other", "replay-1", "hello"); err == nil {
		t.Fatal("foreign complete must fail before status rewrite")
	}
	task, err := svc.Complete("owner", "replay-1", "hello")
	if err != nil || task.Status != model.TaskStatusSucceeded || task.Progress != 100 {
		t.Fatalf("complete: %#v %v", task, err)
	}
	if taskResultText(task.ResultJSON) != "hello" {
		t.Fatalf("result json: %s", task.ResultJSON)
	}
	if _, err := svc.Append("owner", "replay-1", "more"); authMessage(err) != "已结束任务不能继续写入文本增量" {
		t.Fatalf("closed append: %v", err)
	}
	if _, err := svc.Complete("owner", "replay-1", "hello"); authMessage(err) != "该文本任务已结束或不属于你，无法完成" {
		t.Fatalf("repeat complete: %v", err)
	}
}

func TestCompleteRejectsNonReplayStatus(t *testing.T) {
	db, svc := openReplay(t)
	createTask(t, db, "queued", "owner", "text", model.TaskStatusQueued)
	if _, err := svc.Complete("owner", "queued", "body"); authMessage(err) != "该文本任务已结束或不属于你，无法完成" {
		t.Fatalf("queued complete: %v", err)
	}
}

func TestReadCursorAndTerminalProjection(t *testing.T) {
	db, svc := openReplay(t)
	createTask(t, db, "task", "owner", "canvas_text", model.TaskStatusTextReplay)
	if _, err := svc.Append("owner", "task", "one"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Append("owner", "task", "two"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Read("other", "task", 0); err == nil {
		t.Fatal("foreign read must fail")
	}
	all, err := svc.Read("owner", "task", 0)
	if err != nil || len(all.Deltas) != 2 || all.Complete || all.FinalText != "" {
		t.Fatalf("open read: %#v %v", all, err)
	}
	after, err := svc.Read("owner", "task", 1)
	if err != nil || len(after.Deltas) != 1 || after.Deltas[0].Sequence != 2 || after.Deltas[0].Content != "two" {
		t.Fatalf("cursor: %#v %v", after, err)
	}
	if _, err := svc.Complete("owner", "task", "onetwo"); err != nil {
		t.Fatal(err)
	}
	done, err := svc.Read("owner", "task", 0)
	if err != nil || !done.Complete || done.Status != model.TaskStatusSucceeded || done.FinalText != "onetwo" {
		t.Fatalf("terminal read: %#v %v", done, err)
	}
}

func TestFinalizeKeepsDraftOnCancelAndShortensSuccessWindow(t *testing.T) {
	fixed := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	db, _ := openReplay(t)
	logs := &testLog{}
	svc := New(NewStore(repository.New(db)), Dependencies{Logger: logs, Now: func() time.Time { return fixed }})
	createTask(t, db, "fail-1", "owner", "text", model.TaskStatusRunning)
	if _, err := svc.Append("owner", "fail-1", "草稿"); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", "fail-1").Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.Finalize("fail-1", model.TaskStatusFailed); err != nil {
		t.Fatal(err)
	}
	var failed model.Task
	if err := db.First(&failed, "id = ?", "fail-1").Error; err != nil {
		t.Fatal(err)
	}
	if failed.TextDraft != "草稿" {
		t.Fatalf("failed draft: %q", failed.TextDraft)
	}
	var failedDelta model.TaskTextDelta
	if err := db.First(&failedDelta, "task_id = ?", "fail-1").Error; err != nil {
		t.Fatal(err)
	}
	if !failedDelta.ExpiresAt.Equal(fixed.Add(DraftRetention)) {
		t.Fatalf("failed retention: %s", failedDelta.ExpiresAt)
	}

	createTask(t, db, "ok-1", "owner", "text", model.TaskStatusTextReplay)
	if _, err := svc.Append("owner", "ok-1", "成片"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Complete("owner", "ok-1", "成片"); err != nil {
		t.Fatal(err)
	}
	var okDelta model.TaskTextDelta
	if err := db.First(&okDelta, "task_id = ?", "ok-1").Error; err != nil {
		t.Fatal(err)
	}
	if !okDelta.ExpiresAt.Equal(fixed.Add(SuccessRetention)) {
		t.Fatalf("success retention: %s", okDelta.ExpiresAt)
	}
	if err := svc.Finalize("missing", model.TaskStatusCancelled); err != nil {
		t.Fatalf("missing finalize must be nil: %v", err)
	}
}

func TestSweepMergesExpiredFailedDraftThenDeletes(t *testing.T) {
	fixed := time.Date(2026, 10, 2, 15, 0, 0, 0, time.UTC)
	db, _ := openReplay(t)
	svc := New(NewStore(repository.New(db)), Dependencies{Now: func() time.Time { return fixed }})
	createTask(t, db, "expired", "owner", "text", model.TaskStatusFailed)
	if err := db.Create(&model.TaskTextDelta{
		ID: "d1", UserID: "owner", TaskID: "expired", Sequence: 1, Content: "left", ByteCount: 4, ExpiresAt: fixed.Add(-time.Minute),
	}).Error; err != nil {
		t.Fatal(err)
	}
	deleted, err := svc.Sweep()
	if err != nil || deleted != 1 {
		t.Fatalf("sweep: deleted=%d err=%v", deleted, err)
	}
	var task model.Task
	if err := db.First(&task, "id = ?", "expired").Error; err != nil {
		t.Fatal(err)
	}
	if task.TextDraft != "left" {
		t.Fatalf("merged draft: %q", task.TextDraft)
	}
	var count int64
	if err := db.Model(&model.TaskTextDelta{}).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("expired deltas remain: %d", count)
	}
}

func TestConcurrentAppendAssignsUniqueSequences(t *testing.T) {
	db, svc := openReplay(t)
	createTask(t, db, "race", "owner", "text", model.TaskStatusTextReplay)
	const n = 20
	var wg sync.WaitGroup
	seqs := make(chan int64, n)
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			item, err := svc.Append("owner", "race", strings.Repeat("a", i+1))
			if err != nil {
				errs <- err
				return
			}
			seqs <- item.Sequence
		}(i)
	}
	wg.Wait()
	close(errs)
	close(seqs)
	for err := range errs {
		t.Fatal(err)
	}
	seen := map[int64]bool{}
	for seq := range seqs {
		if seen[seq] {
			t.Fatalf("duplicate sequence %d", seq)
		}
		seen[seq] = true
	}
	if len(seen) != n {
		t.Fatalf("got %d sequences", len(seen))
	}
}

func TestConcurrentCompleteAndAppendCloseTheWindow(t *testing.T) {
	db, svc := openReplay(t)
	createTask(t, db, "close", "owner", "text", model.TaskStatusTextReplay)
	var wg sync.WaitGroup
	wg.Add(2)
	var completeErr, appendErr error
	go func() {
		defer wg.Done()
		_, completeErr = svc.Complete("owner", "close", "final")
	}()
	go func() {
		defer wg.Done()
		time.Sleep(5 * time.Millisecond)
		_, appendErr = svc.Append("owner", "close", "late")
	}()
	wg.Wait()
	if completeErr != nil {
		t.Fatal(completeErr)
	}
	if appendErr == nil {
		read, err := svc.Read("owner", "close", 0)
		if err != nil {
			t.Fatal(err)
		}
		if !read.Complete {
			t.Fatal("complete did not close the task")
		}
		if _, err := svc.Append("owner", "close", "after"); authMessage(err) != "已结束任务不能继续写入文本增量" {
			t.Fatalf("post-complete append: %v", err)
		}
		return
	}
	if authMessage(appendErr) != "已结束任务不能继续写入文本增量" {
		t.Fatalf("racing append: %v", appendErr)
	}
}

func TestCachedReadIsolatesUsersCursorsAndCopies(t *testing.T) {
	db, svc := openReplay(t)
	createTask(t, db, "task", "user", "canvas_text", model.TaskStatusRunning)
	for i, content := range []string{"one", "two"} {
		if err := db.Create(&model.TaskTextDelta{ID: content, UserID: "user", TaskID: "task", Sequence: int64(i + 1), Content: content, ExpiresAt: time.Now().Add(time.Hour)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	var queries atomic.Int32
	if err := db.Callback().Query().Before("gorm:query").Register("cache-count", func(*gorm.DB) { queries.Add(1) }); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := svc.CachedRead(context.Background(), "user", "task", 0)
			if err != nil {
				t.Error(err)
				return
			}
			if len(result.Deltas) != 2 || result.Deltas[0].Content != "one" {
				t.Errorf("unexpected replay: %#v", result)
				return
			}
			result.Deltas[0].Content = "caller mutation"
		}()
	}
	wg.Wait()
	if queries.Load() != 2 {
		t.Fatalf("expected one task+delta query, got %d queries", queries.Load())
	}
	if _, err := svc.CachedRead(context.Background(), "other", "task", 0); err == nil {
		t.Fatal("cross-user cache leak")
	}
	result, err := svc.CachedRead(context.Background(), "user", "task", 1)
	if err != nil || len(result.Deltas) != 1 || result.Deltas[0].Sequence != 2 {
		t.Fatalf("cursor isolation: %#v %v", result, err)
	}
	check, err := svc.CachedRead(context.Background(), "user", "task", 0)
	if err != nil || check.Deltas[0].Content != "one" {
		t.Fatalf("copy isolation: %#v %v", check, err)
	}
	svc.ClearCache()
	if err := db.Model(&model.Task{}).Where("id = ?", "task").Update("status", model.TaskStatusSucceeded).Error; err != nil {
		t.Fatal(err)
	}
	result, err = svc.CachedRead(context.Background(), "user", "task", 0)
	if err != nil || !result.Complete {
		t.Fatalf("terminal refresh: %#v %v", result, err)
	}
}

func TestQuotaUsesExistingEventAndByteCaps(t *testing.T) {
	db, svc := openReplay(t)
	createTask(t, db, "quota", "owner", "text", model.TaskStatusTextReplay)
	if err := db.Create(&model.TaskTextDelta{
		ID: "big", UserID: "owner", TaskID: "quota", Sequence: 1, Content: "x", ByteCount: MaxTaskBytes, ExpiresAt: time.Now().Add(time.Hour),
	}).Error; err != nil {
		t.Fatal(err)
	}
	mapped, err := svc.Append("owner", "quota", "x")
	if mapped != nil || authMessage(err) != "文本回放增量已达到配额，请等待任务归并后继续" {
		t.Fatalf("mapped quota: %#v %v", mapped, err)
	}
}
