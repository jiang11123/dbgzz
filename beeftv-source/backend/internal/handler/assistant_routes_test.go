package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistant"
	"infinite-canvas/backend/internal/assistantruntime"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// 内置助手对外只有这一条链路：页面 → 同源后端 → 宿主。
// 这里用真实的路由、真实的 SQLite 画布与一个替身宿主验证契约，
// 特别是「轮前快照由后端建立、写入带回合归属、撤销写回新版本」这几条只能在后端成立的前提。

// assistantTestHostToken 是替身宿主出示的宿主凭据；真实注入路径见 hostEnv。
const assistantTestHostToken = "test-host-token"
const assistantTestNonce = "assistant-test-instance-nonce"

func assistantInstanceProof() string {
	return assistantruntime.InstanceProof(assistantTestNonce)
}

type assistantTestEnv struct {
	router        *gin.Engine
	service       *app.Service
	clients       *agentops.ClientRegistry
	assistantHost *assistantruntime.Host
	uiToken       string
	canvasID      string
	hostHits      map[string]int
}

func newAssistantTestEnv(t *testing.T, host func(env *assistantTestEnv) http.Handler) *assistantTestEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "assistant.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "local", Name: "本地工作区"}).Error; err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	service := app.NewLocal(repository.New(db), dataDir)
	owner, err := service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	canvasID := "assistant-canvas"
	doc := map[string]any{"id": canvasID, "title": "助手回归", "revision": 0,
		"nodes":       []any{map[string]any{"id": "n1", "type": "text", "title": "起点", "position": map[string]any{"x": 0, "y": 0}}},
		"connections": []any{}}
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpsertUserCanvasProject(owner.ID, encoded); err != nil {
		t.Fatal(err)
	}
	env := &assistantTestEnv{service: service, canvasID: canvasID, hostHits: map[string]int{}}
	t.Setenv("BEEFTV_AGENT_HOST_TOKEN", assistantTestHostToken)
	t.Setenv("BEEFTV_AGENT_HOST_URL", "http://127.0.0.1:18500")

	ui := newUISessionStore()
	env.uiToken = ui.issue(owner.ID).Token
	assistantHost := assistantruntime.New(assistantruntime.OptionsFromService(service))
	t.Cleanup(func() { _ = assistantHost.Stop() })
	env.assistantHost = assistantHost
	if host != nil {
		inner := host(env)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get(assistantruntime.InstanceHeader) != assistantTestNonce {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"ok":false,"reason":"instance_mismatch"}`))
				return
			}
			inner.ServeHTTP(w, r)
		}))
		t.Cleanup(server.Close)
		assistantHost.TestingUseOwnedEndpoint(server.URL, assistantTestNonce, "")
	}
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{AssistantHost: assistantHost}))
	api := router.Group("/api")
	clients := agentops.NewClientRegistry(dataDir)
	env.clients = clients
	RegisterAgentProxyRoutes(api, service, clients, ui, assistantHost)
	// 操作层与生产走同一条注册路径：替身宿主通过真实 HTTP 入口写画布，
	// 「回执与业务写入同事务」这条前提才有意义。
	RegisterAgentOpsRoutes(api, service, agentops.NewStore(db), clients)
	env.router = router
	return env
}

// opsRaw 走真实的 /api/ops/:op HTTP 入口，用来验证归属、严格解码与 scope 边界。
func (e *assistantTestEnv) opsRaw(op, opID, turnID, params string) (int, string) {
	body := `{"opId":` + strconv.Quote(opID) + `,"params":` + params + `}`
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:18090/api/ops/"+op, strings.NewReader(body))
	request.Host = "127.0.0.1:18090"
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Beeftv-Agent-Token", assistantTestHostToken)
	if turnID != "" {
		request.Header.Set("X-Beeftv-Agent-Turn", turnID)
	}
	recorder := httptest.NewRecorder()
	e.router.ServeHTTP(recorder, request)
	return recorder.Code, recorder.Body.String()
}

// 显式注入的供应商：让状态解析不依赖真实渠道配置，测试只验证路由与契约。
func useEnvProvider(t *testing.T, protocol string) {
	t.Helper()
	t.Setenv("BEEFTV_AGENT_API_KEY", "test-key")
	t.Setenv("BEEFTV_AGENT_BASE_URL", "https://relay.example.com/v1")
	t.Setenv("BEEFTV_AGENT_MODEL", "MiniMax-M3")
	t.Setenv("BEEFTV_AGENT_PROTOCOL", protocol)
}

func (e *assistantTestEnv) call(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return e.callWithHeaders(t, method, path, body, map[string]string{"X-Beeftv-Ui-Session": e.uiToken})
}

func (e *assistantTestEnv) callWithTimeout(t *testing.T, timeout time.Duration, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return e.callWithHeadersTimeout(t, timeout, method, path, body, map[string]string{"X-Beeftv-Ui-Session": e.uiToken})
}

func (e *assistantTestEnv) callWithHeaders(t *testing.T, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	return e.callWithHeadersTimeout(t, 0, method, path, body, headers)
}

func (e *assistantTestEnv) callWithHeadersTimeout(t *testing.T, timeout time.Duration, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, "http://127.0.0.1:18090/api"+path, reader)
	request.Host = "127.0.0.1:18090"
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		if value == "" {
			request.Header.Del(key)
			continue
		}
		request.Header.Set(key, value)
	}
	if timeout > 0 {
		ctx, cancel := context.WithTimeout(request.Context(), timeout)
		t.Cleanup(cancel)
		request = request.WithContext(ctx)
	}
	recorder := httptest.NewRecorder()
	e.router.ServeHTTP(recorder, request)
	return recorder
}

func decodeEnvelope(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var envelope struct {
		Code   int            `json:"code"`
		Reason string         `json:"reason"`
		Data   map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("响应不是信封 JSON: %s", recorder.Body.String())
	}
	if envelope.Data == nil {
		envelope.Data = map[string]any{}
	}
	envelope.Data["__code"] = float64(envelope.Code)
	envelope.Data["__reason"] = envelope.Reason
	return envelope.Data
}

// 状态在模型/凭据/宿主任一环节缺失时都要给出机器可读原因，而不是一句「不可用」。
func TestAssistantStatusReportsResolvedModelAndReasons(t *testing.T) {
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.hostHits[r.URL.Path]++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"busy":false,"model":"MiniMax-M3","instance":"` + assistantInstanceProof() + `"}`))
		})
	})

	useEnvProvider(t, "chat-completion")
	data := decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/status", ""))
	if available, _ := data["available"].(bool); !available {
		t.Fatalf("宿主健康时状态应可用: %#v", data)
	}
	modelInfo, _ := data["model"].(map[string]any)
	if modelInfo["id"] != "MiniMax-M3" {
		t.Fatalf("状态应带上解析出的模型: %#v", data["model"])
	}

	// 模型/凭据没解析出来时，宿主是否健康都不影响结论。
	for _, key := range []string{"BEEFTV_AGENT_API_KEY", "BEEFTV_AGENT_BASE_URL", "BEEFTV_AGENT_MODEL", "BEEFTV_AGENT_PROTOCOL"} {
		t.Setenv(key, "")
	}
	data = decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/status", ""))
	if available, _ := data["available"].(bool); available {
		t.Fatal("未配置模型时状态不应可用")
	}
	if data["reason"] != app.AssistantReasonModelNotConfigured {
		t.Fatalf("reason 应为 %s，得到 %v", app.AssistantReasonModelNotConfigured, data["reason"])
	}
}

// 宿主不可达且本机没有配置启动命令时，状态必须落到 host_unreachable，而不是假装可用。
func TestAssistantStatusReportsUnreachableHost(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	useEnvProvider(t, "chat-completion")

	data := decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/status", ""))
	if available, _ := data["available"].(bool); available {
		t.Fatal("宿主不可达时不应可用")
	}
	if data["reason"] != "host_unreachable" && data["reason"] != "host_start_failed" {
		t.Fatalf("reason 应指向宿主问题，得到 %v", data["reason"])
	}
}

// 对话流：后端生成 turnId 与轮前版本交给宿主，并从 turn_end 记住这轮的变更；
// 之后按轮撤销把轮前文档写成新版本。
func TestAssistantChatRecordsTurnChangeAndUndoRestoresDocument(t *testing.T) {
	var captured struct {
		TurnID         string `json:"turnId"`
		RevisionBefore int64  `json:"revisionBefore"`
		SessionID      string `json:"sessionId"`
	}
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.hostHits[r.URL.Path]++
			if r.URL.Path == "/health" {
				_, _ = w.Write([]byte(`{"ok":true,"busy":false,"instance":"` + assistantInstanceProof() + `"}`))
				return
			}
			if r.URL.Path == "/history" {
				_ = json.NewEncoder(w).Encode(map[string]any{"sessionId": "session", "turns": []any{map[string]any{"turnId": captured.TurnID}}})
				return
			}
			if r.URL.Path != "/chat" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			// 替身宿主用与内置宿主相同的入口写画布：宿主凭据 + 后端签发的 turnId，
			// 让回执与业务写入落在同一个事务里，撤销才能只靠回执重建这一轮。
			owner, _ := env.service.LocalWorkspaceOwner()
			raw, _ := env.service.UserCanvasProject(owner.ID, env.canvasID)
			var doc map[string]any
			_ = json.Unmarshal(raw, &doc)
			revision, _ := doc["revision"].(float64)
			params, _ := json.Marshal(map[string]any{
				"canvasId": env.canvasID, "expectedRevision": int64(revision),
				"nodes": []any{map[string]any{"title": "助手节点", "type": "text"}}})
			status, opBody := env.opsRaw("canvas.nodes.create", "host-turn-op-1", captured.TurnID, string(params))
			if status != http.StatusOK {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(opBody))
				return
			}
			var opResult struct {
				Data struct {
					Result struct {
						Revision int64 `json:"revision"`
						Created  []struct {
							ID string `json:"id"`
						} `json:"created"`
					} `json:"result"`
				} `json:"data"`
			}
			if err := json.Unmarshal([]byte(opBody), &opResult); err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			createdIDs := make([]string, 0, len(opResult.Data.Result.Created))
			for _, node := range opResult.Data.Result.Created {
				createdIDs = append(createdIDs, node.ID)
			}
			w.Header().Set("Content-Type", "application/x-ndjson")
			_, _ = w.Write([]byte(`{"type":"text_delta","delta":"好"}` + "\n"))
			line, _ := json.Marshal(map[string]any{"type": "turn_end", "turnId": captured.TurnID, "reply": "好",
				"toolCalls": []any{}, "proposals": []any{},
				"change": map[string]any{"revisionBefore": captured.RevisionBefore, "revisionAfter": opResult.Data.Result.Revision,
					"createdNodeIds": createdIDs, "updatedNodeIds": []string{}, "createdEdgeIds": []string{}}})
			_, _ = w.Write(append(line, '\n'))
		})
	})
	useEnvProvider(t, "chat-completion")

	recorder := env.call(t, http.MethodPost, "/assistant/chat",
		`{"canvasId":"`+env.canvasID+`","message":"加一个节点","selectedNodeIds":["n1"]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("对话应成功: %d %s", recorder.Code, recorder.Body.String())
	}
	if captured.TurnID == "" {
		t.Fatal("后端必须生成 turnId 交给宿主")
	}
	if captured.RevisionBefore == 0 {
		t.Fatal("后端必须把轮前版本交给宿主")
	}
	if !strings.Contains(recorder.Body.String(), `"turn_end"`) {
		t.Fatalf("流式响应应原样包含 turn_end: %s", recorder.Body.String())
	}

	owner, _ := env.service.LocalWorkspaceOwner()
	before := canvasNodeIDs(t, env.service, owner.ID, env.canvasID)
	if len(before) != 2 {
		t.Fatalf("这轮应写入了一个节点，得到 %v", before)
	}

	undo := decodeEnvelope(t, env.call(t, http.MethodPost, "/assistant/turns/"+captured.TurnID+"/undo",
		`{"canvasId":"`+env.canvasID+`"}`))
	revision, _ := undo["revision"].(float64)
	if int64(revision) <= captured.RevisionBefore {
		t.Fatalf("撤销必须产生新版本，得到 %v", undo)
	}
	if after := canvasNodeIDs(t, env.service, owner.ID, env.canvasID); len(after) != 1 || after[0] != "n1" {
		t.Fatalf("撤销后应回到轮前节点集合，得到 %v", after)
	}
	history := decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/history?canvasId="+env.canvasID, ""))
	turns, _ := history["turns"].([]any)
	if len(turns) != 1 || turns[0].(map[string]any)["undone"] != true {
		t.Fatalf("history did not include durable undo state: %v", history)
	}

	// 已撤销的轮次不能再撤一次。
	recorder = env.call(t, http.MethodPost, "/assistant/turns/"+captured.TurnID+"/undo", `{"canvasId":"`+env.canvasID+`"}`)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("重复撤销应是 409，得到 %d %s", recorder.Code, recorder.Body.String())
	}
	if reason := decodeEnvelope(t, recorder)["__reason"]; reason != app.AssistantTurnReasonAlreadyUndone {
		t.Fatalf("reason 应为 %s，得到 %v", app.AssistantTurnReasonAlreadyUndone, reason)
	}
}

// 未知轮次与不属于当前工作区的画布都必须被拒绝：撤销是写路径，不接受空 scope。
func TestAssistantUndoRejectsUnknownTurnAndForeignCanvas(t *testing.T) {
	env := newAssistantTestEnv(t, nil)

	recorder := env.call(t, http.MethodPost, "/assistant/turns/00112233445566/undo", `{"canvasId":"`+env.canvasID+`"}`)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("未知轮次应是 404，得到 %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = env.call(t, http.MethodPost, "/assistant/turns/00112233445566/undo", `{"canvasId":"not-mine"}`)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("外部画布应是 404，得到 %d", recorder.Code)
	}
}

// 会话与历史只是宿主状态的透传，但 scope 校验与信封解包必须在后端完成。
func TestAssistantSessionsAndHistoryAreProxiedWithScopeCheck(t *testing.T) {
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.hostHits[r.URL.Path]++
			w.Header().Set("Content-Type", "application/json")
			switch {
			case r.URL.Path == "/sessions" && r.Method == http.MethodGet:
				if r.URL.Query().Get("canvasId") != env.canvasID {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				_, _ = w.Write([]byte(`{"currentSessionId":"s1","sessions":[{"sessionId":"s1","title":"加一个节点","updatedAt":"2026-01-01T00:00:00Z","turnCount":1}]}`))
			case r.URL.Path == "/sessions" && r.Method == http.MethodPost:
				_, _ = w.Write([]byte(`{"sessionId":"s2"}`))
			case r.URL.Path == "/history":
				_, _ = w.Write([]byte(`{"sessionId":"s1","turns":[{"turnId":"t1","userText":"加一个节点","selectedNodeIds":["n1"],"reply":"好","toolCalls":[],"change":null,"proposals":[],"error":null,"cancelled":false,"createdAt":"2026-01-01T00:00:00Z"}]}`))
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		})
	})

	data := decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/sessions?canvasId="+url.QueryEscape(env.canvasID), ""))
	if data["currentSessionId"] != "s1" {
		t.Fatalf("会话列表应被解包成契约形状: %#v", data)
	}
	if list, _ := data["sessions"].([]any); len(list) != 1 {
		t.Fatalf("会话条目异常: %#v", data["sessions"])
	}

	data = decodeEnvelope(t, env.call(t, http.MethodPost, "/assistant/sessions", `{"canvasId":"`+env.canvasID+`"}`))
	if data["sessionId"] != "s2" {
		t.Fatalf("新建会话应回 sessionId: %#v", data)
	}

	data = decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/history?canvasId="+url.QueryEscape(env.canvasID), ""))
	turns, _ := data["turns"].([]any)
	if len(turns) != 1 {
		t.Fatalf("历史条目异常: %#v", data)
	}
	turn, _ := turns[0].(map[string]any)
	if turn["userText"] != "加一个节点" {
		t.Fatalf("历史必须是用户原文，得到 %v", turn["userText"])
	}

	// 不属于当前工作区的画布不能借会话/历史入口探测宿主。
	if recorder := env.call(t, http.MethodGet, "/assistant/sessions?canvasId=not-mine", ""); recorder.Code != http.StatusNotFound {
		t.Fatalf("外部画布应是 404，得到 %d", recorder.Code)
	}
	if env.hostHits["/sessions"] != 2 {
		t.Fatalf("scope 未通过时不应转发给宿主，命中 %d 次", env.hostHits["/sessions"])
	}
}

func TestAssistantStatusBusyOldModelAfterProviderChange(t *testing.T) {
	running := assistant.Provider{
		ChannelID: "env", Model: "old-model", BaseURL: "https://relay.example.com/v1",
		Protocol: "chat-completion", APIKey: "old-key",
	}
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.hostHits[r.URL.Path]++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"busy":true,"model":"old-model","instance":"` + assistantInstanceProof() + `"}`))
		})
	})
	env.assistantHost.TestingUseOwnedEndpoint(env.assistantHost.Endpoint(), assistantTestNonce, running.Fingerprint())
	useEnvProvider(t, "chat-completion")
	t.Setenv("BEEFTV_AGENT_MODEL", "MiniMax-M3")

	data := decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/status", ""))
	if available, _ := data["available"].(bool); available {
		t.Fatalf("忙碌的旧模型不得标成新模型已就绪: %#v", data)
	}
	if data["reason"] != "host_busy" {
		t.Fatalf("reason 应为 host_busy，得到 %#v", data)
	}
	modelInfo, _ := data["model"].(map[string]any)
	if modelInfo["id"] != "old-model" {
		t.Fatalf("忙碌时应报告正在跑的旧模型，得到 %#v", data["model"])
	}
}

func TestAssistantStatusUncertainHealthDoesNotRelaunchOnFingerprintChange(t *testing.T) {
	running := assistant.Provider{
		ChannelID: "env", Model: "old-model", BaseURL: "https://relay.example.com/v1",
		Protocol: "chat-completion", APIKey: "old-key",
	}
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.hostHits[r.URL.Path]++
			if r.URL.Path == "/health" {
				<-r.Context().Done()
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
	})
	owned := env.assistantHost.Endpoint()
	env.assistantHost.TestingUseOwnedEndpoint(owned, assistantTestNonce, running.Fingerprint())
	useEnvProvider(t, "chat-completion")
	t.Setenv("BEEFTV_AGENT_MODEL", "MiniMax-M3")

	data := decodeEnvelope(t, env.callWithTimeout(t, 300*time.Millisecond, http.MethodGet, "/assistant/status", ""))
	if env.assistantHost.Endpoint() != owned || !env.assistantHost.Running() {
		t.Fatalf("探测失败不得杀掉自有子进程 endpoint=%q running=%v", env.assistantHost.Endpoint(), env.assistantHost.Running())
	}
	if available, _ := data["available"].(bool); available {
		t.Fatalf("健康未知时不得标成已就绪: %#v", data)
	}
	if data["reason"] != "host_starting" && data["reason"] != "host_unreachable" {
		t.Fatalf("健康未知时应保留子进程并报告未就绪，得到 %#v", data)
	}
}

func TestAssistantCancelRequiresWriteAndOwnedCanvas(t *testing.T) {
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.hostHits[r.URL.Path]++
			if r.URL.Path == "/health" {
				_, _ = w.Write([]byte(`{"ok":true,"busy":false,"instance":"` + assistantInstanceProof() + `"}`))
				return
			}
			if r.URL.Path == "/cancel" && r.Method == http.MethodPost {
				w.WriteHeader(http.StatusAccepted)
				_, _ = w.Write([]byte(`{"accepted":true}`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
	})

	owned := env.call(t, http.MethodPost, "/assistant/cancel", `{"canvasId":"`+env.canvasID+`"}`)
	if owned.Code != http.StatusOK {
		t.Fatalf("拥有的画布取消应转发宿主: %d %s", owned.Code, owned.Body.String())
	}
	if env.hostHits["/cancel"] != 1 {
		t.Fatalf("拥有的画布应命中宿主一次，得到 %d", env.hostHits["/cancel"])
	}

	foreign := env.call(t, http.MethodPost, "/assistant/cancel", `{"canvasId":"not-mine"}`)
	if foreign.Code != http.StatusNotFound {
		t.Fatalf("外部画布应是 404，得到 %d %s", foreign.Code, foreign.Body.String())
	}
	if env.hostHits["/cancel"] != 1 {
		t.Fatalf("外部画布不得转发给宿主，命中 %d", env.hostHits["/cancel"])
	}

	reg, token, err := env.clients.Register("readonly", agentops.ClientReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	readOnly := env.callWithHeaders(t, http.MethodPost, "/assistant/cancel", `{"canvasId":"`+env.canvasID+`"}`, map[string]string{
		"X-Beeftv-Client": reg.ID, "Authorization": "Bearer " + token,
	})
	if readOnly.Code != http.StatusForbidden {
		t.Fatalf("只读客户端应是 403，得到 %d %s", readOnly.Code, readOnly.Body.String())
	}
	if reason := decodeEnvelope(t, readOnly)["__reason"]; reason != "read_only_client" {
		t.Fatalf("reason 应为 read_only_client，得到 %v", reason)
	}
	if env.hostHits["/cancel"] != 1 {
		t.Fatalf("只读客户端不得转发给宿主，命中 %d", env.hostHits["/cancel"])
	}
}

func TestAssistantStatusAndProxyIgnoreForeignHostURL(t *testing.T) {
	hits := 0
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"busy":false,"model":"foreign","instance":"not-ours"}`))
	}))
	t.Cleanup(foreign.Close)

	env := newAssistantTestEnv(t, nil)
	t.Setenv("BEEFTV_AGENT_HOST_URL", foreign.URL)
	useEnvProvider(t, "chat-completion")

	status := decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/status", ""))
	if available, _ := status["available"].(bool); available {
		t.Fatalf("不得把环境变量 HOST_URL 当成自有宿主: %#v", status)
	}
	chat := env.call(t, http.MethodPost, "/assistant/chat", `{"canvasId":"`+env.canvasID+`","message":"x"}`)
	if chat.Code != http.StatusServiceUnavailable {
		t.Fatalf("无自有子进程时对话应 503，得到 %d %s", chat.Code, chat.Body.String())
	}
	cancel := env.call(t, http.MethodPost, "/assistant/cancel", `{"canvasId":"`+env.canvasID+`"}`)
	if cancel.Code != http.StatusServiceUnavailable {
		t.Fatalf("无自有子进程时取消应 503，得到 %d %s", cancel.Code, cancel.Body.String())
	}
	if hits != 0 {
		t.Fatalf("status/chat/cancel 不得打到外部 HOST_URL，hits=%d", hits)
	}
}

func canvasNodeIDs(t *testing.T, service *app.Service, userID, canvasID string) []string {
	t.Helper()
	raw, err := service.UserCanvasProject(userID, canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Nodes []struct {
			ID string `json:"id"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(doc.Nodes))
	for _, node := range doc.Nodes {
		out = append(out, node.ID)
	}
	return out
}
