package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 旧内置 Agent 的产品边界测试：通用任务入口不能再创建旧 Agent 任务，历史遗留的
// 排队任务不会被执行（更不能调用模型），但任务行本身保留。
func retiredAgentDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "retired-agent.db")+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(database.LocalModels()...); err != nil {
		t.Fatal(err)
	}
	return db
}

// 直接构造的最小 Service：用于单条命令级断言，不启动后台 worker。
func retiredAgentService(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	db := retiredAgentDB(t)
	return &Service{repo: repository.New(db), dataDir: t.TempDir(), mode: serviceModeLocal}, db
}

// 真实产品组合根（NewLocal）：用于验证 worker 生命周期里到底启动了哪些后台循环。
func retiredAgentProductService(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	db := retiredAgentDB(t)
	service := NewLocal(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = service.Close() })
	return service, db
}

func TestGenericTaskCreationRejectsRetiredAgentOperations(t *testing.T) {
	for _, request := range []CreateTaskRequest{
		{Type: "canvas_text", Operation: "cloud_agent", Prompt: "帮我改画布"},
		{Type: "canvas_text", Operation: "cloud_agent_step", Prompt: "继续执行"},
		// 记忆压缩的 operation 不以 cloud_agent 开头，曾经能绕过前缀判定自动调用文本模型。
		{Type: "canvas_text", Operation: "agent_memory_compact", Prompt: "压缩优化个人 Agent 记忆"},
		{Type: "canvas_text", Prompt: "帮我改画布", Input: map[string]any{"mode": "text", "cloudAgent": map[string]any{"version": 1}}},
	} {
		s, db := retiredAgentService(t)
		_, err := s.CreateTask("user", request)
		if err == nil {
			t.Fatalf("通用任务入口仍然接受了退场 Agent 请求: %#v", request)
		}
		if !strings.Contains(err.Error(), "Agent") || !strings.Contains(err.Error(), "已下线") {
			t.Fatalf("错误信息不是产品边界: %v", err)
		}
		var count int64
		if err = db.Model(&model.Task{}).Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("被拒绝的请求写了 %d 条任务", count)
		}
	}
}

func newLegacyAgentProbe(t *testing.T) (*Service, *gorm.DB, *atomic.Int64) {
	t.Helper()
	s, db := retiredAgentService(t)
	return newLegacyAgentProbeWith(t, s, db)
}

func newProductLegacyAgentProbe(t *testing.T) (*Service, *gorm.DB, *atomic.Int64) {
	t.Helper()
	s, db := retiredAgentProductService(t)
	return newLegacyAgentProbeWith(t, s, db)
}

func newLegacyAgentProbeWith(t *testing.T, s *Service, db *gorm.DB) (*Service, *gorm.DB, *atomic.Int64) {
	t.Helper()
	var upstreamHits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamHits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"不应发生"}}]}`))
	}))
	t.Cleanup(upstream.Close)
	if err := db.Create(&model.ModelChannel{ID: "channel", Scope: model.ChannelScopeSystem, Enabled: true, Name: "本地测试渠道", BaseURL: upstream.URL, APIKey: "test-only"}).Error; err != nil {
		t.Fatal(err)
	}
	capabilityConfig, err := json.Marshal(DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "text-test"))
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Create(&model.ChannelModel{ID: "cm", ChannelID: "channel", ModelKey: "text-test", Capability: "text", Protocol: model.ChannelInterfaceChatCompletion, CapabilityConfigJSON: string(capabilityConfig), Enabled: true}).Error; err != nil {
		t.Fatal(err)
	}
	return s, db, &upstreamHits
}

// 旧版本留下的排队记录必须被终态拒绝，而不是当成普通文本生成执行。
// 判定要覆盖三种历史形态：operation 前缀、只有 input.cloudAgent 标记、记忆压缩 operation。
func TestWorkerTerminatesLegacyAgentTasksWithoutCallingModel(t *testing.T) {
	cases := []struct {
		name      string
		operation string
		inputJSON string
	}{
		{
			name: "cloud_agent operation", operation: cloudAgentOperation,
			inputJSON: `{"mode":"text","prompt":"帮我改画布","config":{"channelId":"channel","model":"text-test"}}`,
		},
		{
			name: "cloud_agent_step operation", operation: "cloud_agent_step",
			inputJSON: `{"mode":"text","prompt":"继续执行","config":{"channelId":"channel","model":"text-test"}}`,
		},
		{
			name: "legacy input.cloudAgent marker without operation", operation: "canvas_text",
			inputJSON: `{"mode":"text","cloudAgent":{"version":1},"prompt":"帮我改画布","config":{"channelId":"channel","model":"text-test"}}`,
		},
		{
			name: "agent memory compact operation", operation: cloudAgentMemoryCompactOp,
			inputJSON: `{"mode":"text","prompt":"压缩优化个人 Agent 记忆","config":{"channelId":"channel","model":"text-test"}}`,
		},
	}
	for index, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			s, db, upstreamHits := newLegacyAgentProbe(t)
			now := time.Now()
			legacy := model.Task{
				ID: fmt.Sprintf("legacy-agent-%d", index), UserID: "user", ProjectID: "canvas-1", Type: "canvas_text",
				Operation: testCase.operation, Status: model.TaskStatusQueued, Stage: "排队中", Prompt: "帮我改画布",
				CreatedAt: now, UpdatedAt: now, InputJSON: testCase.inputJSON,
			}
			if err := db.Create(&legacy).Error; err != nil {
				t.Fatal(err)
			}
			if err := s.ProcessNextTask(); err != nil {
				t.Fatal(err)
			}
			if upstreamHits.Load() != 0 {
				t.Fatalf("退场 Agent 任务仍然调用了模型 %d 次", upstreamHits.Load())
			}
			var stored model.Task
			if err := db.First(&stored, "id = ?", legacy.ID).Error; err != nil {
				t.Fatalf("历史任务行被删除: %v", err)
			}
			if stored.Status != model.TaskStatusFailed || stored.Stage != "功能已下线" {
				t.Fatalf("历史任务 status=%s stage=%s, want failed/功能已下线", stored.Status, stored.Stage)
			}
			if !strings.Contains(stored.Error, "Agent") || !strings.Contains(stored.Error, "已下线") {
				t.Fatalf("历史 Agent 任务失败原因不是产品边界: %q", stored.Error)
			}
			// 终态结算仍走既有机制：租约由 UpdateTaskTerminalState 释放。
			if stored.LeaseOwner != "" || stored.LeaseExpiresAt != nil {
				t.Fatalf("拒绝后租约没有释放: owner=%q expires=%v", stored.LeaseOwner, stored.LeaseExpiresAt)
			}
		})
	}
}

func TestRetryOfLegacyAgentTaskIsRefused(t *testing.T) {
	s, db := retiredAgentService(t)
	now := time.Now()
	legacy := model.Task{
		ID: "legacy-agent-failed", UserID: "user", ProjectID: "canvas-1", Type: "canvas_text", Operation: cloudAgentOperation,
		Status: model.TaskStatusFailed, Stage: "任务失败", Error: "上一版失败原因", Prompt: "帮我改画布",
		CreatedAt: now, UpdatedAt: now, InputJSON: `{"mode":"text","prompt":"帮我改画布"}`,
	}
	if err := db.Create(&legacy).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.RetryTask("user", legacy.ID); err == nil {
		t.Fatal("退场 Agent 任务仍然可以重试")
	} else if !strings.Contains(err.Error(), "已下线") {
		t.Fatalf("重试拒绝原因不是产品边界: %v", err)
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", legacy.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.TaskStatusFailed || stored.Error != "上一版失败原因" {
		t.Fatalf("重试被拒后历史任务记录被改动: status=%s error=%q", stored.Status, stored.Error)
	}
}

// 旧 Agent 记忆的周期压缩会在后台自动调用用户的文本模型。它必须留在产品生命周期
// 之外：即便存在“到期”的记忆设置和已批准记忆，worker 启动后也不能派发压缩任务。
// 这是一个有界缺席观察（等待上限 750ms），因为只有“不该发生的事没有发生”可观察。
func TestWorkerStartDoesNotScheduleRetiredAgentMemoryCompaction(t *testing.T) {
	s, db, upstreamHits := newProductLegacyAgentProbe(t)
	if err := db.Create(&model.AgentMemorySetting{
		UserID: "user", CompactInterval: model.AgentMemoryCompactIntervalDaily,
		ChannelID: "channel", ChannelModelKey: "text-test", Model: "text-test",
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AgentLesson{
		ID: "lesson-1", Topic: "画布改写", Category: "canvas", Situation: "需要改画布", Lesson: "先读快照",
		Status: model.AgentLessonStatusApproved, AuthorUserID: "user",
	}).Error; err != nil {
		t.Fatal(err)
	}
	s.StartWorker()
	deadline := time.Now().Add(750 * time.Millisecond)
	for {
		var compactTasks int64
		if err := db.Model(&model.Task{}).Where("operation = ?", cloudAgentMemoryCompactOp).Count(&compactTasks).Error; err != nil {
			t.Fatal(err)
		}
		var setting model.AgentMemorySetting
		if err := db.First(&setting, "user_id = ?", "user").Error; err != nil {
			t.Fatal(err)
		}
		if compactTasks != 0 || setting.CompactTaskID != "" || setting.LastStatus != "" {
			stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_ = s.StopWorker(stopCtx)
			cancel()
			t.Fatalf("worker 启动后仍然派发了旧 Agent 记忆压缩: tasks=%d status=%q compactTaskId=%q", compactTasks, setting.LastStatus, setting.CompactTaskID)
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.StopWorker(stopCtx); err != nil {
		t.Fatal(err)
	}
	if upstreamHits.Load() != 0 {
		t.Fatalf("旧 Agent 记忆压缩仍然调用了模型 %d 次", upstreamHits.Load())
	}
}

func TestRetiredAgentRuntimeEntrypointsAreGone(t *testing.T) {
	serviceType := reflect.TypeOf((*Service)(nil))
	for _, name := range []string{
		"CreateCloudAgentRun",
		"CloudAgentRun",
		"advanceCloudAgents",
		"startAgentMemoryCompactScheduler",
		"MCPSession",
		"InterjectCloudAgent",
		"CancelCloudAgent",
		"DecideCloudAgentApproval",
		"UndoCloudAgentCanvas",
		"UpdateCloudAgentProfile",
		"UserAgentMemories",
		"CompactUserAgentMemories",
	} {
		if _, ok := serviceType.MethodByName(name); ok {
			t.Fatalf("退场入口仍然存在: Service.%s", name)
		}
	}
}

func TestAgentRequestsWithoutCloudAgentMarkerAreNotRetired(t *testing.T) {
	s, db := retiredAgentService(t)
	_, err := s.CreateTask("user", CreateTaskRequest{
		Type: "canvas_text", Operation: "text", Prompt: "点评这张图",
		Input: map[string]any{
			"mode": "text", "prompt": "点评这张图",
			"agentRequests": map[string]any{"canonical": map[string]any{"messages": []any{map[string]any{"role": "user", "content": "点评"}}}},
		},
	})
	if err != nil && strings.Contains(err.Error(), "已下线") {
		t.Fatalf("普通工具文本任务被当成退场 Agent: %v", err)
	}
	var count int64
	if err := db.Model(&model.Task{}).Where("operation LIKE ?", "cloud_agent%").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("工具文本任务写了 %d 条旧 Agent operation", count)
	}
}
