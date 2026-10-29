package app

import (
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestNewLocalKeepsLocalBoundaries(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.PluginPlatformState{}, &model.UserPluginState{}); err != nil {
		t.Fatal(err)
	}

	svc := NewLocal(repository.New(db), t.TempDir())
	if svc == nil {
		t.Fatal("NewLocal returned nil")
	}
	if !svc.IsLocalMode() {
		t.Fatal("local service must report local runtime mode")
	}
	if !svc.localResourceStorage {
		t.Fatal("local service must use local resource storage")
	}
	if svc.coordinator == nil {
		t.Fatal("local service must initialize a local coordinator")
	}
	if svc.pluginRuntime == nil {
		t.Fatal("local service must keep protocol plugins available")
	}
	policy, err := svc.RuntimePolicy()
	if err != nil {
		t.Fatalf("local runtime policy: %v", err)
	}
	if policy.Resource.StoredFileGB != 999 || policy.Task.ActiveTaskLimit != 999 {
		t.Fatalf("local runtime policy = %#v, want self-use limits", policy)
	}
}

func TestLocalFeatureAvailabilityDoesNotReadHostedSettings(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), t.TempDir())
	features, err := svc.FeatureAvailability()
	if err != nil {
		t.Fatal(err)
	}
	if !features.ShortDramaEnabled || !features.TaskCenterEnabled || !features.PluginCenterEnabled {
		t.Fatalf("local features unexpectedly disabled: %#v", features)
	}
	if features.FrontendModelsEnabled {
		t.Fatalf("local commercial/system features unexpectedly enabled: %#v", features)
	}
	for _, feature := range []string{FeatureShortDrama, FeatureTaskCenter, FeaturePluginCenter, FeatureCustomChannels, FeatureTimelineTranscription} {
		enabled, err := svc.FeatureEnabled(feature)
		if err != nil || !enabled {
			t.Fatalf("local feature %s = enabled:%v err:%v", feature, enabled, err)
		}
	}
}

func TestLocalTaskListReturnsLocalTaskSummary(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := db.Create(&model.Task{ID: "local-task-1", UserID: "local", Status: model.TaskStatusSucceeded, Type: "image", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), t.TempDir())
	tasks, err := svc.TasksWithOptions("local", TaskListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 {
		t.Fatalf("local task count = %d, want 1", len(tasks))
	}
	if tasks[0].ID != "local-task-1" || tasks[0].Status != model.TaskStatusSucceeded {
		t.Fatalf("unexpected local task summary: %#v", tasks[0])
	}
}

func TestLocalServiceSkipsHostedActivityAnalytics(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.UserDailyActivity{}); err != nil {
		t.Fatal(err)
	}

	svc := NewLocal(repository.New(db), t.TempDir())
	svc.recordActivity("local", "task", 1)

	var count int64
	if err := db.Model(&model.UserDailyActivity{}).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("local activity analytics rows = %d, want 0", count)
	}
}

func TestLocalTaskListReturnsSafeActionableFailure(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	raw := `{"error":{"code":"400","message":"素材转换失败: Height must be between 300px and 6000px. api_key=PRIVATE_LIST_TEST","type":"api_error"}}`
	if err := db.Create(&model.Task{ID: "failed-video", UserID: "local", Type: "video", Status: model.TaskStatusFailed, Error: raw}).Error; err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), t.TempDir())
	tasks, err := svc.TasksWithOptions("local", TaskListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 {
		t.Fatalf("task count = %d", len(tasks))
	}
	got := tasks[0]
	if got.ErrorCode != "invalid_params" || !strings.Contains(got.Error, "300–6000") || strings.Contains(got.Error, "PRIVATE_LIST_TEST") || strings.Contains(got.Error, `{"error"`) {
		t.Fatalf("unsafe or missing list error: %#v", got)
	}
}
