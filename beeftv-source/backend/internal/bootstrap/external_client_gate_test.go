package bootstrap

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/agentops"
)

// desktopHarness 按桌面形态打开运行时，并提供一个「像桌面界面那样」发请求的入口。
type desktopHarness struct {
	rt      *Runtime
	dataDir string
	t       *testing.T
}

func newDesktopHarness(t *testing.T) *desktopHarness {
	t.Helper()
	// The production route requires the packaged CLI before issuing credentials.
	// This fixture is beside Go's disposable test executable, never an installed app.
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	name := "beeftv"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	cliDir := filepath.Join(filepath.Dir(executable), "cli")
	cliPath := filepath.Join(cliDir, name)
	if _, err := os.Stat(cliPath); os.IsNotExist(err) {
		if err := os.MkdirAll(cliDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(cliPath, []byte("test CLI fixture"), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Remove(cliPath); _ = os.Remove(cliDir) })
	}
	dir := t.TempDir()
	rt, err := Open(context.Background(), Config{Profile: ProfileDesktop, DataDir: dir, ListenAddr: "127.0.0.1:0", AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rt.Close(context.Background()) })
	return &desktopHarness{rt: rt, dataDir: dir, t: t}
}

type requestOptions struct {
	method       string
	path         string
	body         string
	origin       string
	launchToken  string
	uiBootstrap  string
	clientID     string
	clientToken  string
	remoteAddr   string
	extraHeaders map[string]string
}

func (h *desktopHarness) call(options requestOptions) *httptest.ResponseRecorder {
	h.t.Helper()
	body := options.body
	if body == "" {
		body = "{}"
	}
	request := httptest.NewRequest(options.method, "http://127.0.0.1:54321/api"+options.path, strings.NewReader(body))
	request.RemoteAddr = "127.0.0.1:12345"
	if options.remoteAddr != "" {
		request.RemoteAddr = options.remoteAddr
	}
	request.Header.Set("Content-Type", "application/json")
	if options.origin != "" {
		request.Header.Set("Origin", options.origin)
	}
	if options.launchToken != "" {
		request.Header.Set("X-Desktop-Token", options.launchToken)
	}
	if options.uiBootstrap != "" {
		request.Header.Set("X-Beeftv-UI-Bootstrap", options.uiBootstrap)
	}
	if options.clientID != "" {
		request.Header.Set("X-Beeftv-Client", options.clientID)
		request.Header.Set("Authorization", "Bearer "+options.clientToken)
	}
	for name, value := range options.extraHeaders {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	h.rt.Handler().ServeHTTP(recorder, request)
	return recorder
}

// desktopUI 模拟受信任的桌面界面：启动令牌 + UI 引导密钥 + Wails 原生 Origin。
func (h *desktopHarness) desktopUI(method, path, body string) *httptest.ResponseRecorder {
	return h.call(requestOptions{method: method, path: path, body: body,
		origin: "wails://wails", launchToken: h.rt.LaunchToken(), uiBootstrap: h.rt.UIBootstrapToken()})
}

func decodeEnvelope(t *testing.T, recorder *httptest.ResponseRecorder) (map[string]any, string) {
	t.Helper()
	var envelope struct {
		Data   map[string]any `json:"data"`
		Reason string         `json:"reason"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("响应不是合法 JSON：%s", recorder.Body.String())
	}
	return envelope.Data, envelope.Reason
}

// 契约 B5：已登记客户端凭据可以免桌面启动令牌进入操作层，但只能进操作层。
func TestOpsGateAcceptsRegisteredClientWithoutLaunchToken(t *testing.T) {
	harness := newDesktopHarness(t)
	registration, token, err := agentops.NewClientRegistry(harness.dataDir).RegisterKind("codex", "codex", agentops.ClientReadOnly)
	if err != nil {
		t.Fatal(err)
	}

	listing := harness.call(requestOptions{method: "GET", path: "/ops", clientID: registration.ID, clientToken: token})
	if listing.Code != http.StatusOK {
		t.Fatalf("已登记客户端应能列出操作，得到 %d %s", listing.Code, listing.Body.String())
	}

	// 操作入口也放行：这里画布不存在，所以失败原因必须是业务错误，不是被守卫拦下。
	operation := harness.call(requestOptions{method: "POST", path: "/ops/canvas.get",
		body: `{"params":{"canvasId":"missing"}}`, clientID: registration.ID, clientToken: token})
	if _, reason := decodeEnvelope(t, operation); reason == "desktop_token_required" {
		t.Fatalf("已登记客户端在操作入口被启动令牌守卫拦下：%d %s", operation.Code, operation.Body.String())
	}
}

// 伪造或不存在的凭据不能换来豁免：守卫回落到启动令牌，结果是 403。
func TestOpsGateRejectsBogusClientCredentials(t *testing.T) {
	harness := newDesktopHarness(t)
	registration, token, err := agentops.NewClientRegistry(harness.dataDir).Register("codex", agentops.ClientReadWrite)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name        string
		clientID    string
		clientToken string
	}{
		{"未登记的 ID", "client-does-not-exist", token},
		{"登记过的 ID 配错误 token", registration.ID, "0000000000000000"},
		{"空 token", registration.ID, ""},
	}
	for _, item := range cases {
		recorder := harness.call(requestOptions{method: "GET", path: "/ops", clientID: item.clientID, clientToken: item.clientToken})
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("%s 应被拒绝，得到 %d %s", item.name, recorder.Code, recorder.Body.String())
		}
	}
}

// 凭据发行与助手运行面继续要求桌面身份，完整业务客户端不能进入。
func TestClientCredentialsOnOtherRoutesStillNeedLaunchToken(t *testing.T) {
	harness := newDesktopHarness(t)
	registration, token, err := agentops.NewClientRegistry(harness.dataDir).Register("codex", agentops.ClientReadWrite)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ method, path string }{
		{"GET", "/agent-clients"},
		{"POST", "/agent-clients"},
		{"DELETE", "/agent-clients/" + registration.ID},
		{"POST", "/ops/clients"},
		{"GET", "/ops/clients"},
		{"POST", "/assistant/ui-session"},
		{"POST", "/assistant/chat"},
	} {
		recorder := harness.call(requestOptions{method: item.method, path: item.path, clientID: registration.ID, clientToken: token})
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("%s %s 不该对客户端凭据开放，得到 %d", item.method, item.path, recorder.Code)
		}
		if _, reason := decodeEnvelope(t, recorder); reason != "desktop_token_required" {
			t.Fatalf("%s %s 的失败原因应为 desktop_token_required，得到 %q", item.method, item.path, reason)
		}
	}
}

// 非本机来源即使带着有效客户端凭据也不豁免。
func TestOpsGateExemptionIsLoopbackOnly(t *testing.T) {
	harness := newDesktopHarness(t)
	registration, token, err := agentops.NewClientRegistry(harness.dataDir).Register("codex", agentops.ClientReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	recorder := harness.call(requestOptions{method: "GET", path: "/ops",
		clientID: registration.ID, clientToken: token, remoteAddr: "203.0.113.7:44321"})
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("外部来源应被拒绝，得到 %d %s", recorder.Code, recorder.Body.String())
	}
}

// 契约 B1/B2/B3 的完整一轮：桌面界面签发凭据 → 外部客户端可用 → 吊销后立即失效。
func TestAgentClientIssueUseAndRevoke(t *testing.T) {
	harness := newDesktopHarness(t)

	created := harness.desktopUI("POST", "/agent-clients", `{"kind":"codex","mode":"read-only","label":"我的 Codex"}`)
	if created.Code != http.StatusOK {
		t.Fatalf("桌面界面应能签发凭据，得到 %d %s", created.Code, created.Body.String())
	}
	data, _ := decodeEnvelope(t, created)
	token, _ := data["token"].(string)
	if token == "" {
		t.Fatal("签发响应必须带一次性 token")
	}
	client, _ := data["client"].(map[string]any)
	clientID, _ := client["id"].(string)
	if clientID == "" {
		t.Fatalf("签发响应缺少客户端 ID：%s", created.Body.String())
	}
	if client["kind"] != "codex" || client["mode"] != "read-only" {
		t.Fatalf("签发响应的 kind/mode 不对：%v", client)
	}
	if client["lastUsedAt"] != nil {
		t.Fatalf("新签发的凭据不该有使用时间：%v", client["lastUsedAt"])
	}
	setup, _ := data["setup"].(map[string]any)
	command, _ := setup["command"].(string)
	if !strings.Contains(command, "codex mcp add") || !strings.Contains(command, "mcp serve") {
		t.Fatalf("codex 接入命令不可用：%q", command)
	}
	if !strings.Contains(command, clientID) || !strings.Contains(command, token) {
		t.Fatal("接入命令必须带上这个客户端自己的凭据")
	}
	if strings.Contains(command, harness.rt.LaunchToken()) {
		t.Fatal("接入命令绝不能包含桌面启动令牌")
	}
	if !strings.Contains(command, "--read-only") {
		t.Fatalf("只读客户端的接入命令应带 --read-only：%q", command)
	}

	// 签发出来的凭据立刻能进操作层，不需要桌面启动令牌。
	used := harness.call(requestOptions{method: "GET", path: "/ops", clientID: clientID, clientToken: token})
	if used.Code != http.StatusOK {
		t.Fatalf("新签发的凭据应能立即使用，得到 %d %s", used.Code, used.Body.String())
	}

	// 用过之后列表里要能看到最近使用时间，并且永远不返回 token 或哈希。
	listing := harness.desktopUI("GET", "/agent-clients", "")
	if listing.Code != http.StatusOK {
		t.Fatalf("桌面界面应能列出客户端，得到 %d %s", listing.Code, listing.Body.String())
	}
	if strings.Contains(listing.Body.String(), token) || strings.Contains(listing.Body.String(), "tokenHash") {
		t.Fatal("列表泄露了凭据")
	}
	listed, _ := decodeEnvelope(t, listing)
	clients, _ := listed["clients"].([]any)
	if len(clients) != 1 {
		t.Fatalf("应有 1 个客户端，得到 %d", len(clients))
	}
	first, _ := clients[0].(map[string]any)
	if first["lastUsedAt"] == nil {
		t.Fatal("用过的凭据应记录最近使用时间")
	}
	cli, _ := listed["cli"].(map[string]any)
	if _, ok := cli["path"].(string); !ok {
		t.Fatalf("列表必须给出 CLI 路径：%v", cli)
	}
	if _, ok := cli["available"].(bool); !ok {
		t.Fatalf("列表必须说明 CLI 是否随包可用：%v", cli)
	}
	if install, _ := cli["installCommand"].(string); install == "" {
		t.Fatal("列表必须给出把 CLI 接到 PATH 的命令")
	}

	// 吊销：立刻失效，并从列表里消失。
	revoked := harness.desktopUI("DELETE", "/agent-clients/"+clientID, "")
	if revoked.Code != http.StatusOK {
		t.Fatalf("桌面界面应能吊销凭据，得到 %d %s", revoked.Code, revoked.Body.String())
	}
	afterRevoke := harness.call(requestOptions{method: "GET", path: "/ops", clientID: clientID, clientToken: token})
	if afterRevoke.Code != http.StatusForbidden {
		t.Fatalf("已吊销的凭据必须立即失效，得到 %d %s", afterRevoke.Code, afterRevoke.Body.String())
	}
	if _, reason := decodeEnvelope(t, afterRevoke); reason != "desktop_token_required" {
		t.Fatalf("已吊销凭据应回落到启动令牌守卫，得到 %q", reason)
	}
	emptyListing, _ := decodeEnvelope(t, harness.desktopUI("GET", "/agent-clients", ""))
	if remaining, _ := emptyListing["clients"].([]any); len(remaining) != 0 {
		t.Fatalf("已吊销的客户端不该继续出现在列表里：%v", remaining)
	}
	// 重复吊销按未找到处理，不把存在性变成探测手段。
	if again := harness.desktopUI("DELETE", "/agent-clients/"+clientID, ""); again.Code != http.StatusNotFound {
		t.Fatalf("重复吊销应返回未找到，得到 %d %s", again.Code, again.Body.String())
	}
}

// 读写模式的接入命令不带 --read-only，cursor/other 给的是 JSON 配置。
func TestAgentClientMissingCLIRejectsBeforeIssuingCredentials(t *testing.T) {
	harness := newDesktopHarness(t)
	listing := harness.desktopUI("GET", "/agent-clients", "")
	data, _ := decodeEnvelope(t, listing)
	cli := data["cli"].(map[string]any)
	cliPath := cli["path"].(string)
	if err := os.Remove(cliPath); err != nil {
		t.Fatal(err)
	}
	response := harness.desktopUI("POST", "/agent-clients", `{"kind":"claude-desktop","mode":"read-only"}`)
	if _, reason := decodeEnvelope(t, response); response.Code != http.StatusPreconditionFailed || reason != "cli_unavailable" {
		t.Fatalf("missing CLI must fail closed: %d %s", response.Code, response.Body.String())
	}
	listing = harness.desktopUI("GET", "/agent-clients", "")
	data, _ = decodeEnvelope(t, listing)
	cli = data["cli"].(map[string]any)
	if cli["available"] != false || cli["installCommand"] != "" || len(data["clients"].([]any)) != 0 {
		t.Fatalf("missing CLI must not issue credentials or a PATH fallback: %s", listing.Body.String())
	}
}

func TestAgentClientSetupShapes(t *testing.T) {
	harness := newDesktopHarness(t)
	for _, item := range []struct {
		kind      string
		mode      string
		wantKey   string
		wantInner string
	}{
		{"claude", "read-write", "command", "claude mcp add"},
		{"claude-desktop", "read-only", "json", "mcpServers"},
		{"cursor", "read-write", "json", "mcpServers"},
		{"other", "read-only", "json", "mcpServers"},
	} {
		recorder := harness.desktopUI("POST", "/agent-clients", `{"kind":"`+item.kind+`","mode":"`+item.mode+`"}`)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s 签发失败：%d %s", item.kind, recorder.Code, recorder.Body.String())
		}
		data, _ := decodeEnvelope(t, recorder)
		setup, _ := data["setup"].(map[string]any)
		value, _ := setup[item.wantKey].(string)
		if !strings.Contains(value, item.wantInner) {
			t.Fatalf("%s 的 setup.%s 不可用：%q", item.kind, item.wantKey, value)
		}
		if item.wantKey == "json" {
			var config struct {
				Servers map[string]struct {
					Command string            `json:"command"`
					Env     map[string]string `json:"env"`
				} `json:"mcpServers"`
			}
			if err := json.Unmarshal([]byte(value), &config); err != nil {
				t.Fatal(err)
			}
			entry := config.Servers["beeftv"]
			if !filepath.IsAbs(entry.Command) || filepath.Base(filepath.Dir(entry.Command)) != "cli" {
				t.Fatalf("unsafe CLI command: %q", entry.Command)
			}
			if entry.Env["BEEFTV_DATA_DIR"] != harness.dataDir {
				t.Fatalf("wrong workspace directory: %q", entry.Env["BEEFTV_DATA_DIR"])
			}
		}
		if title, _ := setup["title"].(string); title == "" {
			t.Fatalf("%s 的 setup 缺少标题", item.kind)
		}
		if item.mode == "read-write" && strings.Contains(value, "--read-only") {
			t.Fatalf("读写客户端的配置不该带 --read-only：%q", value)
		}
		if item.mode == "read-only" && !strings.Contains(value, "--read-only") {
			t.Fatalf("只读客户端的配置应带 --read-only：%q", value)
		}
	}
}

// 凭据管理需要桌面界面的信任链：单有启动令牌（没有 UI 引导密钥）不够。
func TestAgentClientRoutesNeedDesktopUITrust(t *testing.T) {
	harness := newDesktopHarness(t)
	recorder := harness.call(requestOptions{method: "GET", path: "/agent-clients",
		origin: "wails://wails", launchToken: harness.rt.LaunchToken()})
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("只有启动令牌不该能管理凭据，得到 %d %s", recorder.Code, recorder.Body.String())
	}
	if unknown := harness.call(requestOptions{method: "GET", path: "/agent-clients",
		origin: "wails://attacker", launchToken: harness.rt.LaunchToken(), uiBootstrap: harness.rt.UIBootstrapToken()}); unknown.Code != http.StatusForbidden {
		t.Fatalf("未知 Origin 不该能管理凭据，得到 %d", unknown.Code)
	}
}

// 无效 mode 必须在登记前就被拒绝，不能落下一条能力不明的记录。
func TestAgentClientRejectsUnknownMode(t *testing.T) {
	harness := newDesktopHarness(t)
	recorder := harness.desktopUI("POST", "/agent-clients", `{"kind":"codex","mode":"admin"}`)
	if recorder.Code == http.StatusOK {
		t.Fatalf("非法 mode 被接受了：%s", recorder.Body.String())
	}
	if _, reason := decodeEnvelope(t, recorder); reason != "invalid_mode" {
		t.Fatalf("非法 mode 的原因应为 invalid_mode，得到 %q", reason)
	}
	listing, _ := decodeEnvelope(t, harness.desktopUI("GET", "/agent-clients", ""))
	if clients, _ := listing["clients"].([]any); len(clients) != 0 {
		t.Fatalf("失败的签发不该留下记录：%v", clients)
	}
}
