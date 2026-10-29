package app

import (
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestIsTextReplayTaskRequest(t *testing.T) {
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
	}
	for _, tc := range cases {
		if got := isTextReplayTaskRequest(tc.input); got != tc.want {
			t.Errorf("%s: isTextReplayTaskRequest(%v) = %v, want %v", tc.name, tc.input, got, tc.want)
		}
	}
}

func TestTextReplayFacadeDelegatesCompleteAppendRead(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "replay.db")+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.TaskTextDelta{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: "task", UserID: "user", Type: "canvas_text", Status: model.TaskStatusTextReplay}).Error; err != nil {
		t.Fatal(err)
	}
	svc := &Service{repo: repository.New(db)}
	if _, err := svc.AppendTaskTextDelta("other", "task", "nope"); err == nil {
		t.Fatal("foreign append must fail")
	}
	item, err := svc.AppendTaskTextDelta("user", "task", "hello")
	if err != nil || item.Sequence != 1 {
		t.Fatalf("append: %#v %v", item, err)
	}
	got, err := svc.TaskTextReplay("user", "task", 0)
	if err != nil || len(got.Deltas) != 1 || got.Complete {
		t.Fatalf("read: %#v %v", got, err)
	}
	task, err := svc.CompleteTextReplayTask("user", "task", "hello")
	if err != nil || task.Status != model.TaskStatusSucceeded {
		t.Fatalf("complete: %#v %v", task, err)
	}
	if _, err := svc.AppendTaskTextDelta("user", "task", "late"); err == nil {
		t.Fatal("closed append must fail")
	}
	done, err := svc.TaskTextReplay("user", "task", 0)
	if err != nil || !done.Complete || done.FinalText != "hello" {
		t.Fatalf("terminal: %#v %v", done, err)
	}
	if err := svc.finalizeTaskTextReplay("missing", model.TaskStatusCancelled); err != nil {
		t.Fatal(err)
	}
}
