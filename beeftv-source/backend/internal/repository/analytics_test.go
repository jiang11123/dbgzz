package repository

import (
	"context"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type sqlCaptureLogger struct {
	statements []string
}

func TestAPICallLogRecordTypeFiltersListAndExport(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:api-log-record-types?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, item := range []model.ApiCallLog{
		{ID: "request", Capability: "video", RequestKind: "create", CreatedAt: now},
		{ID: "poll", Capability: "video", RequestKind: "poll", CreatedAt: now},
		{ID: "video-download", Capability: "video", RequestKind: "download", CreatedAt: now},
		{ID: "image-download", Capability: "image", RequestKind: "download", CreatedAt: now},
	} {
		if err := db.Create(&item).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := New(db)
	for _, tc := range []struct {
		kind  string
		count int
	}{{"", 1}, {"request", 1}, {"download", 2}, {"all", 4}} {
		filter := APICallLogFilter{AnalyticsFilter: AnalyticsFilter{From: now.Add(-time.Hour), To: now.Add(time.Hour)}, RecordType: tc.kind}
		logs, total, err := repo.QueryAPICallLogs(filter)
		if err != nil {
			t.Fatal(err)
		}
		if len(logs) != tc.count || total != int64(tc.count) {
			t.Fatalf("kind=%s: count=%d total=%d", tc.kind, len(logs), total)
		}
		exported, err := repo.ExportAPICallLogs(filter, 100)
		if err != nil || len(exported) != tc.count {
			t.Fatalf("kind=%s: export count=%d err=%v", tc.kind, len(exported), err)
		}
	}
}

func (l *sqlCaptureLogger) LogMode(logger.LogLevel) logger.Interface { return l }
func (*sqlCaptureLogger) Info(context.Context, string, ...any)       {}
func (*sqlCaptureLogger) Warn(context.Context, string, ...any)       {}
func (*sqlCaptureLogger) Error(context.Context, string, ...any)      {}

func (l *sqlCaptureLogger) Trace(_ context.Context, _ time.Time, query func() (string, int64), _ error) {
	statement, _ := query()
	l.statements = append(l.statements, statement)
}

func TestQueryAPICallLogsSearchesFailureFields(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:api-log-error-search?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.ModelChannel{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	item := model.ApiCallLog{
		ID:          "api-log-1",
		UserID:      "user-1",
		RequestKind: "create",
		Status:      model.ApiCallStatusFailed,
		ErrorCode:   "request_not_sent",
		Error:       "模型服务拒绝了请求，请检查模型和参数；上游：invalid parameter: size",
		CreatedAt:   now,
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	for _, keyword := range []string{"模型服务拒绝", "invalid parameter", "request_not_sent"} {
		logs, total, err := repo.QueryAPICallLogs(APICallLogFilter{
			AnalyticsFilter: AnalyticsFilter{From: now.Add(-time.Hour), To: now.Add(time.Hour)},
			Keyword:         keyword,
			Page:            1,
			Limit:           20,
		})
		if err != nil {
			t.Fatalf("QueryAPICallLogs(%q) error = %v", keyword, err)
		}
		if total != 1 || len(logs) != 1 || logs[0].ID != item.ID {
			t.Fatalf("QueryAPICallLogs(%q) = total:%d logs:%#v", keyword, total, logs)
		}
	}
}

func TestQueryAPICallLogsHidesInternalPollStages(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:api-log-visible-stages?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	logs := []model.ApiCallLog{
		{ID: "image-create", UserID: "user-1", Capability: "image", RequestKind: "create", CreatedAt: now},
		{ID: "image-poll", UserID: "user-1", Capability: "image", RequestKind: "poll", CreatedAt: now.Add(time.Second)},
		{ID: "image-download", UserID: "user-1", Capability: "image", RequestKind: "download", CreatedAt: now.Add(2 * time.Second)},
		{ID: "video-create", UserID: "user-1", Capability: "video", RequestKind: "create", CreatedAt: now.Add(3 * time.Second)},
		{ID: "video-poll", UserID: "user-1", Capability: "video", RequestKind: "poll", CreatedAt: now.Add(4 * time.Second)},
	}
	if err := db.Create(&logs).Error; err != nil {
		t.Fatal(err)
	}

	items, total, err := New(db).QueryAPICallLogs(APICallLogFilter{
		AnalyticsFilter: AnalyticsFilter{From: now.Add(-time.Hour), To: now.Add(time.Hour)},
		Page:            1,
		Limit:           20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if total != 2 || len(items) != 2 {
		t.Fatalf("visible logs = total:%d items:%#v, want only create logs without polls or downloads", total, items)
	}
	if items[0].ID != "video-create" || items[1].ID != "image-create" {
		t.Fatalf("visible logs = %#v, want video-create and image-create", items)
	}
}
