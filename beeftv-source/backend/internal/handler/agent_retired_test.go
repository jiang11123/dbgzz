package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 旧内置 Agent 已从产品运行面退场。这里用真实 HTTP 路由图（而不是源码字符串）
// 证明三件事：/agent/* 入口不存在、通用任务 API 不能创建旧 Agent 任务、
// 手工生成任务的创建路径仍然可用。
const retiredAgentBoundaryMessage = "Agent 能力已下线，请在画布中手动创建节点并生成"

type retiredAgentHarness struct {
	router *gin.Engine
	svc    *app.Service
	db     *gorm.DB
}

func newRetiredAgentHarness(t *testing.T) retiredAgentHarness {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "handler.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	// 本地工作区主体必须存在；路由中间件用 ID 解析当前用户。
	if err := db.Create(&model.Workspace{ID: "local", Name: "本地工作区"}).Error; err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	svc := app.NewLocal(repository.New(db), dir)
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dir}))
	RegisterDesktopCanvasAPIWithDependencies(router.Group("/api"), svc, defaultRuntimeDependencies(svc))
	// bootstrap 的真实 404 投影；同时保证“路由不存在”不会伪装成业务错误。
	router.NoRoute(func(c *gin.Context) {
		c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "msg": "请求不存在"})
	})
	return retiredAgentHarness{router: router, svc: svc, db: db}
}

func (h retiredAgentHarness) do(t *testing.T, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, path, reader)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	h.router.ServeHTTP(recorder, request)
	return recorder
}

func TestRetiredAgentEndpointsAreAbsentFromProductRouteGraph(t *testing.T) {
	harness := newRetiredAgentHarness(t)
	for _, route := range harness.router.Routes() {
		// 退场的是旧内置 Agent 的 /api/agent/* 运行面。
		// /api/agent-clients 是另一回事：外部 Agent 的凭据签发与吊销，只对受信任的桌面界面开放。
		if route.Path == "/api/agent" || strings.HasPrefix(route.Path, "/api/agent/") {
			t.Fatalf("旧 Agent 入口仍在产品路由图中: %s %s", route.Method, route.Path)
		}
	}
	for _, probe := range []struct{ method, path string }{
		{http.MethodGet, "/api/agent/capabilities"},
		{http.MethodGet, "/api/agent/profile"},
		{http.MethodPatch, "/api/agent/profile"},
		{http.MethodPost, "/api/agent/runs"},
		{http.MethodPost, "/api/agent/runs/run-1/messages"},
		{http.MethodPost, "/api/agent/runs/run-1/cancel"},
		{http.MethodPost, "/api/agent/runs/run-1/undo"},
		{http.MethodPost, "/api/agent/runs/run-1/approvals/a-1/decision"},
		{http.MethodGet, "/api/agent/runs/run-1/events"},
		{http.MethodGet, "/api/agent/memories"},
		{http.MethodPost, "/api/agent/memories"},
		{http.MethodPost, "/api/agent/memories/compact"},
	} {
		recorder := harness.do(t, probe.method, probe.path, map[string]any{})
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s %s status = %d, want 404 (body=%s)", probe.method, probe.path, recorder.Code, recorder.Body.String())
		}
	}
}

func TestGenericTaskAPICannotCreateRetiredAgentTasks(t *testing.T) {
	harness := newRetiredAgentHarness(t)
	requests := map[string]map[string]any{
		"root run operation":      {"type": "canvas_text", "operation": "cloud_agent", "prompt": "帮我改画布", "projectId": "canvas-1"},
		"agent step operation":    {"type": "canvas_text", "operation": "cloud_agent_step", "prompt": "继续执行", "projectId": "canvas-1"},
		"legacy cloudAgent input": {"type": "canvas_text", "prompt": "帮我改画布", "projectId": "canvas-1", "input": map[string]any{"mode": "text", "cloudAgent": map[string]any{"version": 1}}},
	}
	for name, request := range requests {
		t.Run(name, func(t *testing.T) {
			recorder := harness.do(t, http.MethodPost, "/api/tasks", request)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
			}
			var envelope struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope.Code == 0 {
				t.Fatalf("boundary rejection reported business success: %s", recorder.Body.String())
			}
			if !strings.Contains(envelope.Msg, "Agent") || !strings.Contains(envelope.Msg, "已下线") {
				t.Fatalf("msg = %q, want the retired-Agent product boundary message", envelope.Msg)
			}
			var count int64
			if err := harness.db.Model(&model.Task{}).Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatalf("被拒绝的 Agent 请求仍然落库了 %d 条任务", count)
			}
		})
	}
}

// 手工生成必须继续走通同一个产品写入口：这里给出真实的系统渠道/模型/变体，
// 证明退场只切断 Agent，没有削弱普通任务创建。
func TestManualCanvasTaskCreationStillReachesTaskAdmission(t *testing.T) {
	harness := newRetiredAgentHarness(t)
	seedSystemTextChannel(t, harness.db)
	recorder := harness.do(t, http.MethodPost, "/api/tasks", map[string]any{
		"type": "canvas_text", "prompt": "手工写一段分镜", "model": "text-test",
		"input": map[string]any{"mode": "text", "prompt": "手工写一段分镜", "config": map[string]any{"channelId": "channel", "model": "text-test"}},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("手工生成任务创建失败: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			ID        string `json:"id"`
			Operation string `json:"operation"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Code != 0 || envelope.Data.ID == "" {
		t.Fatalf("手工生成任务没有返回任务标识: %s", recorder.Body.String())
	}
	if strings.Contains(envelope.Data.Operation, "cloud_agent") {
		t.Fatalf("手工生成任务被误标成 Agent 任务: %#v", envelope.Data)
	}
	var stored model.Task
	if err := harness.db.First(&stored, "id = ?", envelope.Data.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Operation != "" && strings.HasPrefix(stored.Operation, "cloud_agent") {
		t.Fatalf("落库任务 operation = %q, 不是手工生成任务", stored.Operation)
	}
}

func seedSystemTextChannel(t *testing.T, db *gorm.DB) {
	t.Helper()
	capabilityConfig, err := json.Marshal(app.DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "text-test"))
	if err != nil {
		t.Fatal(err)
	}
	rows := []any{
		&model.ModelChannel{ID: "channel", Scope: model.ChannelScopeSystem, Enabled: true, Name: "本地测试渠道"},
		&model.ChannelModel{ID: "cm", ChannelID: "channel", ModelKey: "text-test", Capability: "text", Protocol: model.ChannelInterfaceChatCompletion, CapabilityConfigJSON: string(capabilityConfig), Enabled: true},
		&model.ChannelModelVariant{ID: "tier", ChannelModelID: "cm", SelectorKey: "{}", SelectorJSON: "{}", Enabled: true},
	}
	for _, row := range rows {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
}
