package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/model"
)

func TestTrustedDesktopUICanCommitDocument(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	trust := func(r *http.Request) bool {
		return r.Header.Get("X-Desktop-Token") == "launch" && r.Header.Get("X-Beeftv-UI-Bootstrap") == "ui"
	}
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{DesktopTrust: trust}))
	api := router.Group("/api")
	RegisterAgentOpsRoutes(api, env.service, agentops.NewStore(env.service.Database()), env.clients)

	code, body := postOps(t, router, "canvas.document.commit", "ui-doc-1", map[string]string{
		"X-Desktop-Token": "launch", "X-Beeftv-UI-Bootstrap": "ui",
	}, `{"canvasId":"`+env.canvasID+`","expectedRevision":1,"document":{"title":"桌面提交","nodes":[{"id":"n1","type":"text","title":"桌面"}],"connections":[]}}`)
	if code != http.StatusOK {
		t.Fatalf("受信任桌面 UI 提交失败: %d %s", code, body)
	}
	var envelope struct {
		Data struct {
			Caller   string `json:"caller"`
			Revision int64  `json:"revision"`
			Replayed bool   `json:"replayed"`
			OpID     string `json:"opId"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Caller != string(agentops.CallerManual) || envelope.Data.Replayed || envelope.Data.OpID != "ui-doc-1" {
		t.Fatalf("手工写入应可观察为 caller=manual: %s", body)
	}
	var receipts int64
	if err := env.service.Database().Model(&model.AgentOpRecord{}).Where("op_id = ?", "ui-doc-1").Count(&receipts).Error; err != nil {
		t.Fatal(err)
	}
	if receipts != 1 {
		t.Fatalf("回执数 = %d", receipts)
	}

	untrusted, untrustedBody := postOps(t, router, "canvas.document.commit", "loopback-doc", map[string]string{},
		`{"canvasId":"`+env.canvasID+`","expectedRevision":2,"document":{"title":"未授权"}}`)
	if untrusted != http.StatusForbidden {
		t.Fatalf("未授信 loopback 不得写: %d %s", untrusted, untrustedBody)
	}

	hostCode, hostBody := postOps(t, env.router, "canvas.document.commit", "host-doc", map[string]string{
		"X-Beeftv-Agent-Token": assistantTestHostToken,
	}, `{"canvasId":"`+env.canvasID+`","expectedRevision":2,"document":{"title":"宿主整页"}}`)
	if hostCode != http.StatusForbidden {
		t.Fatalf("宿主不得整页提交: %d %s", hostCode, hostBody)
	}

	reg, token, err := env.clients.RegisterKind("codex", "readonly", agentops.ClientReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	roCode, roBody := postOps(t, env.router, "canvas.document.commit", "ro-doc", map[string]string{
		"X-Beeftv-Client": reg.ID, "Authorization": "Bearer " + token,
	}, `{"canvasId":"`+env.canvasID+`","expectedRevision":2,"document":{"title":"只读"}}`)
	if roCode != http.StatusForbidden {
		t.Fatalf("只读客户端不得整页提交: %d %s", roCode, roBody)
	}
}

func postOps(t *testing.T, router http.Handler, op, opID string, headers map[string]string, params string) (int, string) {
	t.Helper()
	body := `{"opId":` + strconvQuote(opID) + `,"params":` + params + `}`
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:18090/api/ops/"+op, strings.NewReader(body))
	request.Host = "127.0.0.1:18090"
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder.Code, recorder.Body.String()
}

func strconvQuote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
