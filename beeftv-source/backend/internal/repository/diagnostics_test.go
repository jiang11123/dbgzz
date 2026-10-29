package repository

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// SQLite serializes time.Time using the value's own offset (e.g.
// "2026-10-12 11:33:40.28605+08:00"), while the export window is built in UTC.
// A raw text comparison then drops rows that fall inside the instant range.
func TestDiagnosticWindowMatchesLocalOffsetTimestamps(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:diag-window-offset?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}

	local := time.FixedZone("CST", 8*60*60)
	inside := time.Date(2026, 10, 12, 11, 33, 40, 286050000, local)
	from := inside.UTC().Add(-time.Minute)
	to := inside.UTC().Add(time.Minute)

	if err := db.Create(&model.Task{ID: "task-local", UserID: "user-1", Status: model.TaskStatusRunning, CreatedAt: inside, UpdatedAt: inside}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.TaskLog{ID: "log-local", UserID: "user-1", TaskID: "task-local", CreatedAt: inside}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{ID: "call-local", UserID: "user-1", TaskID: "task-local", CreatedAt: inside}).Error; err != nil {
		t.Fatal(err)
	}

	repo := New(db)
	tasks, err := repo.DiagnosticTasks("user-1", from, to, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].ID != "task-local" {
		t.Fatalf("tasks = %+v", tasks)
	}
	logs, err := repo.DiagnosticTaskLogs("user-1", from, to, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 || logs[0].ID != "log-local" {
		t.Fatalf("task logs = %+v", logs)
	}
	calls, err := repo.DiagnosticAPICallLogs("user-1", from, to, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0].ID != "call-local" {
		t.Fatalf("api calls = %+v", calls)
	}
}

// A task created before the window but still running/failing inside it must be
// exported, otherwise the failure the user is reporting is missing.
func TestDiagnosticWindowIncludesTasksUpdatedInsideWindow(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:diag-window-updated?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}

	local := time.FixedZone("CST", 8*60*60)
	updated := time.Date(2026, 10, 12, 11, 33, 40, 0, local)
	created := updated.Add(-2 * time.Hour)
	from := updated.UTC().Add(-time.Minute)
	to := updated.UTC().Add(time.Minute)

	if err := db.Create(&model.Task{ID: "task-running", UserID: "user-1", Status: model.TaskStatusRunning, CreatedAt: created, UpdatedAt: updated}).Error; err != nil {
		t.Fatal(err)
	}

	tasks, err := New(db).DiagnosticTasks("user-1", from, to, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].ID != "task-running" {
		t.Fatalf("tasks = %+v", tasks)
	}
}
