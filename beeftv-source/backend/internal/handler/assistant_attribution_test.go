package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
)

// 回合归属的信任边界：只有已鉴权内置宿主能出示归属，外部客户端即使拿到 turnId 也不能冒认；
// 内置助手也只能在「当前画布」上写，跨画布、未知字段、越界素材都在写入之前被拒。

// opsAsClient 以已登记外部客户端的身份调用操作层（真实 HTTP 入口）。
func (e *assistantTestEnv) opsAsClient(clientID, token, op, opID, turnID, params string) (int, string) {
	body := `{"opId":"` + opID + `","params":` + params + `}`
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:18090/api/ops/"+op, strings.NewReader(body))
	request.Host = "127.0.0.1:18090"
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Beeftv-Client", clientID)
	request.Header.Set("Authorization", "Bearer "+token)
	if turnID != "" {
		request.Header.Set("X-Beeftv-Agent-Turn", turnID)
	}
	recorder := httptest.NewRecorder()
	e.router.ServeHTTP(recorder, request)
	return recorder.Code, recorder.Body.String()
}

func (e *assistantTestEnv) canvasSnapshot(t *testing.T) (int64, int) {
	t.Helper()
	revision, err := e.canvasRevisionQuiet()
	if err != nil {
		t.Fatal(err)
	}
	owner, err := e.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := e.service.UserCanvasProject(owner.ID, e.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Nodes []any `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return revision, len(doc.Nodes)
}

// canvasRevisionQuiet 不调用 t.Fatal：它可以安全地在 httptest 的服务 goroutine 里使用。
func (e *assistantTestEnv) canvasRevisionQuiet() (int64, error) {
	owner, err := e.service.LocalWorkspaceOwner()
	if err != nil {
		return 0, err
	}
	raw, err := e.service.UserCanvasProject(owner.ID, e.canvasID)
	if err != nil {
		return 0, err
	}
	var doc struct {
		Revision int64 `json:"revision"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return 0, err
	}
	return doc.Revision, nil
}

func (e *assistantTestEnv) beginTurn(t *testing.T, turnID string, input app.AssistantTurnInput) {
	t.Helper()
	owner, err := e.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.service.BeginAssistantTurn(owner.ID, e.canvasID, turnID, input); err != nil {
		t.Fatal(err)
	}
}

func envelopeReason(t *testing.T, body string) string {
	t.Helper()
	var payload struct {
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("响应不是信封 JSON: %s", body)
	}
	return payload.Reason
}

func TestAgentOpsRejectsForgedTurnFromRegisteredClient(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	const turnID = "aaaa1111aaaa1111"
	env.beginTurn(t, turnID, app.AssistantTurnInput{})

	registration, token, err := env.clients.Register("外部 CLI", agentops.ClientReadWrite)
	if err != nil {
		t.Fatal(err)
	}
	revision, nodes := env.canvasSnapshot(t)
	params := mustJSONString(t, map[string]any{"canvasId": env.canvasID, "expectedRevision": revision,
		"nodes": []any{map[string]any{"title": "冒认写入", "type": "text"}}})

	// 已登记读写客户端拿到 turnId 也不能自报归属：否则撤销会连它的写入一起抹掉。
	status, body := env.opsAsClient(registration.ID, token, "canvas.nodes.create", "forged-1", turnID, params)
	if status != http.StatusForbidden {
		t.Fatalf("伪造回合归属应被拒绝，得到 %d %s", status, body)
	}
	if afterRevision, afterNodes := env.canvasSnapshot(t); afterRevision != revision || afterNodes != nodes {
		t.Fatal("被拒绝的伪造写入不能改动画布")
	}

	// 同一客户端不带归属仍然按登记模式正常工作（不收窄外部客户端已有权限）。
	status, body = env.opsAsClient(registration.ID, token, "canvas.nodes.create", "legit-1", "", params)
	if status != http.StatusOK {
		t.Fatalf("外部客户端正常写入不应被收窄，得到 %d %s", status, body)
	}
	if _, afterNodes := env.canvasSnapshot(t); afterNodes != nodes+1 {
		t.Fatal("外部客户端写入应真的落地")
	}
}

func TestAgentOpsRejectsCrossCanvasWriteFromAssistant(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	other := map[string]any{"id": "other-canvas", "title": "别的画布", "revision": 0,
		"nodes": []any{}, "connections": []any{}}
	encoded, _ := json.Marshal(other)
	if _, err := env.service.UpsertUserCanvasProject(owner.ID, encoded); err != nil {
		t.Fatal(err)
	}
	const turnID = "bbbb2222bbbb2222"
	env.beginTurn(t, turnID, app.AssistantTurnInput{})

	revision, _ := env.canvasSnapshot(t)
	params := mustJSONString(t, map[string]any{"canvasId": "other-canvas", "expectedRevision": revision,
		"nodes": []any{map[string]any{"title": "越界节点", "type": "text"}}})
	status, body := env.opsRaw("canvas.nodes.create", "cross-canvas-1", turnID, params)
	if status != http.StatusForbidden {
		t.Fatalf("跨画布写入应被拒绝，得到 %d %s", status, body)
	}
	if reason := envelopeReason(t, body); reason != "scope_denied" {
		t.Fatalf("拒绝原因应为 scope_denied，得到 %s", reason)
	}
}

func TestAgentOpsRejectsUnknownParamsOverHTTP(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	const turnID = "cccc3333cccc3333"
	env.beginTurn(t, turnID, app.AssistantTurnInput{})
	revision, _ := env.canvasSnapshot(t)

	params := mustJSONString(t, map[string]any{"canvasId": env.canvasID, "nodeId": "n1", "expectedRevision": revision,
		"patch": map[string]any{"title": "改名", "temperature": 0.7}})
	status, body := env.opsRaw("canvas.node.update", "unknown-http-1", turnID, params)
	if status != http.StatusBadRequest {
		t.Fatalf("含未知字段的请求应被拒绝，得到 %d %s", status, body)
	}
	if reason := envelopeReason(t, body); reason != "unknown_field" {
		t.Fatalf("拒绝原因应为 unknown_field，得到 %s", reason)
	}
	if afterRevision, _ := env.canvasSnapshot(t); afterRevision != revision {
		t.Fatal("被拒绝的请求不能推进画布版本")
	}
}

// 浏览器断流（没有 turn_end）时，已经落地的助手写入仍必须可撤销：
// 回合继续开放以允许恢复；撤销仍从与业务写入同事务的回执重建。
func TestAssistantUndoRecoversAfterStreamBreakWithoutTurnEnd(t *testing.T) {
	var captured struct {
		TurnID string `json:"turnId"`
	}
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.hostHits[r.URL.Path]++
			if r.URL.Path != "/chat" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_ = json.NewDecoder(r.Body).Decode(&captured)
			// 这个 handler 跑在 httptest 的服务 goroutine 上：不能用 t.Fatal，
			// 任何失败都以 500 返回，由主测试线程断言。
			revision, revErr := env.canvasRevisionQuiet()
			params, marshalErr := json.Marshal(map[string]any{"canvasId": env.canvasID, "expectedRevision": revision,
				"nodes": []any{map[string]any{"title": "断流节点", "type": "text"}}})
			if revErr != nil || marshalErr != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			if status, body := env.opsRaw("canvas.nodes.create", "host-break-1", captured.TurnID, string(params)); status != http.StatusOK {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(body))
				return
			}
			w.Header().Set("Content-Type", "application/x-ndjson")
			// 没有完成回执的 EOF 不得撤销仍在恢复中的写入授权。
			_, _ = w.Write([]byte(`{"type":"text_delta","delta":"写好了"}` + "\n"))
		})
	})
	useEnvProvider(t, "chat-completion")

	recorder := env.call(t, http.MethodPost, "/assistant/chat",
		`{"canvasId":"`+env.canvasID+`","message":"加一个节点"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("对话应成功建立流: %d %s", recorder.Code, recorder.Body.String())
	}
	if captured.TurnID == "" {
		t.Fatal("后端必须生成 turnId 交给宿主")
	}
	if _, nodes := env.canvasSnapshot(t); nodes != 2 {
		t.Fatalf("宿主写入应当落地，得到 %d 个节点", nodes)
	}
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	if _, open, err := env.service.AssistantTurnScopeForHost(owner.ID, captured.TurnID); err != nil || !open {
		t.Fatalf("宿主断流后应保留恢复权限: open=%v err=%v", open, err)
	}

	undo := decodeEnvelope(t, env.call(t, http.MethodPost, "/assistant/turns/"+captured.TurnID+"/undo",
		`{"canvasId":"`+env.canvasID+`"}`))
	if _, ok := undo["revision"].(float64); !ok {
		t.Fatalf("没有 turn_end 的回合也必须能从回执撤销: %#v", undo)
	}
	if _, nodes := env.canvasSnapshot(t); nodes != 1 {
		t.Fatalf("撤销后应回到轮前节点集合，得到 %d 个节点", nodes)
	}
	if _, open, err := env.service.AssistantTurnScopeForHost(owner.ID, captured.TurnID); err != nil || open {
		t.Fatalf("明确撤销后不得恢复写入: open=%v err=%v", open, err)
	}
}

// 界面显式引用的额外画布必须由对话入口校验归属后写入这一轮的范围：
// 引用成功则助手能只读它，未引用/不存在的资源整轮拒绝、不转发给宿主。
func TestAssistantChatGrantsOnlyVerifiedReferences(t *testing.T) {
	type observed struct {
		turnID      string
		refCanvas   int
		otherCanvas int
	}
	var seen observed
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.hostHits[r.URL.Path]++
			if r.URL.Path != "/chat" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			var body struct {
				TurnID string `json:"turnId"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			seen.turnID = body.TurnID
			// 宿主按后端签发的回合身份读取：被引用的画布可读，别的画布不可读。
			seen.refCanvas, _ = env.opsRaw("canvas.get", "", body.TurnID, `{"canvasId":"ref-canvas"}`)
			seen.otherCanvas, _ = env.opsRaw("canvas.get", "", body.TurnID, `{"canvasId":"other-canvas"}`)
			w.Header().Set("Content-Type", "application/x-ndjson")
			_, _ = w.Write([]byte(`{"type":"turn_end","turnId":"` + body.TurnID + `","reply":"好","toolCalls":[],"proposals":[],"change":null}` + "\n"))
		})
	})
	useEnvProvider(t, "chat-completion")
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"ref-canvas", "other-canvas"} {
		encoded, _ := json.Marshal(map[string]any{"id": id, "title": id, "revision": 0, "nodes": []any{}, "connections": []any{}})
		if _, err := env.service.UpsertUserCanvasProject(owner.ID, encoded); err != nil {
			t.Fatal(err)
		}
	}

	// 不存在的素材引用：整轮拒绝，且不转发给宿主。
	recorder := env.call(t, http.MethodPost, "/assistant/chat",
		`{"canvasId":"`+env.canvasID+`","message":"看看","references":[{"kind":"asset","id":"missing-asset"}]}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("不存在的引用应整轮拒绝，得到 %d %s", recorder.Code, recorder.Body.String())
	}
	if env.hostHits["/chat"] != 0 {
		t.Fatal("引用校验失败时不应转发给宿主")
	}

	// 真实画布引用：通过校验并成为这一轮的只读范围。
	recorder = env.call(t, http.MethodPost, "/assistant/chat",
		`{"canvasId":"`+env.canvasID+`","message":"看看","references":[{"kind":"canvas","id":"ref-canvas"}]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("合法引用应成功: %d %s", recorder.Code, recorder.Body.String())
	}
	if seen.refCanvas != http.StatusOK {
		t.Fatalf("被引用的画布应可读，得到 %d", seen.refCanvas)
	}
	if seen.otherCanvas != http.StatusForbidden {
		t.Fatalf("未被引用的画布应被拒，得到 %d", seen.otherCanvas)
	}
}

func mustJSONString(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
