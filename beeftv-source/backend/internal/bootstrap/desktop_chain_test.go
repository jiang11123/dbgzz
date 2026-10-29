package bootstrap_test

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/bootstrap"
)

// 桌面形态启动链的集成验收（无 GUI）：
//   - UI 会话凭桌面启动令牌签发，不需要 BEEFTV_UI_BOOTSTRAP，也不需要把 owner 凭据交给页面；
//   - 宿主由启动链按本机配置里的随包启动器拉起（这里用暂存的 Resources 布局）；
//   - 模型连接信息来自应用已有的本地模型配置，不需要进程内临时密钥；
//   - 关闭 Runtime 时本进程启动的宿主子进程被回收。
//
// 注意：这个用例覆盖共享启动函数与随包资源寻址，不代表 Wails WebView 里的页面引导已验收。
func TestDesktopProfileStartupChain(t *testing.T) {
	workspaceRoot := filepath.Clean(filepath.Join("..", "..", ".."))
	hostSource := filepath.Join(workspaceRoot, "agent-host")
	if _, err := os.Stat(filepath.Join(hostSource, "server.mjs")); err != nil {
		t.Skipf("agent-host 源码不可用: %v", err)
	}
	nodeSource := os.Getenv("BEEFTV_TEST_NODE")
	if nodeSource == "" {
		t.Skip("未设置 BEEFTV_TEST_NODE（自包含 node 二进制路径），跳过随包运行时的集成验收")
	}
	// Exercise persisted channel configuration, never inherited provider overrides.
	// Inherited PORT / HOST_URL are not runtime authority; the supervisor binds a
	// fresh loopback endpoint after launch.
	for _, key := range []string{"BEEFTV_AGENT_API_KEY", "BEEFTV_AGENT_BASE_URL", "BEEFTV_AGENT_MODEL", "BEEFTV_AGENT_PROTOCOL", "BEEFTV_AGENT_HOST_TOKEN", "BEEFTV_UI_BOOTSTRAP", "BEEFTV_AGENT_PORT", "BEEFTV_AGENT_HOST_URL"} {
		t.Setenv(key, "")
	}
	if os.Getenv("BEEFTV_TEST_REAL_TURN") != "1" {
		t.Setenv("BEEFTV_AGENT_MAX_REQUESTS", "0")
	}

	dataDir := t.TempDir()
	stageRoot := t.TempDir()
	// 暂存 BeefTV.app 布局：Contents/Resources/agent-host/...
	agentDir := filepath.Join(stageRoot, "BeefTV.app", "Contents", "Resources", "agent-host")
	if err := os.MkdirAll(filepath.Join(agentDir, "runtime", "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"server.mjs", "session-identity.mjs", "canvas-turn.mjs", "request-budget.mjs", "durable-request-budget.mjs",
		"durable-session-owner.mjs", "durable-stream-text.mjs", "durable-turn-budget.mjs", "media-content.mjs", "native-part-store.mjs",
		"native-history.mjs", "skill-resource.mjs", "operation-bridge.mjs", "canvas-read-view.mjs",
		"session-owner.mjs", "system-prompt.mjs", "model-stream-idle.mjs", "plan.mjs", "studio-digest.mjs", "package.json", "run-agent-host.sh",
	} {
		copyFile(t, filepath.Join(hostSource, name), filepath.Join(agentDir, name))
	}
	if err := os.Chmod(filepath.Join(agentDir, "run-agent-host.sh"), 0o755); err != nil {
		t.Fatal(err)
	}
	copyFile(t, nodeSource, filepath.Join(agentDir, "runtime", "bin", "node"))
	if err := os.Chmod(filepath.Join(agentDir, "runtime", "bin", "node"), 0o755); err != nil {
		t.Fatal(err)
	}
	// 与发行脚本一致地真实复制依赖目录：符号链接会让 ESM 解析走到源目录之外，
	// 验收就失去「随包资源自洽」的意义。
	dependencies, err := filepath.EvalSymlinks(filepath.Join(hostSource, "node_modules"))
	if err != nil {
		t.Fatalf("定位 agent-host 依赖目录失败: %v", err)
	}
	if output, err := exec.Command("cp", "-R", dependencies, filepath.Join(agentDir, "node_modules")).CombinedOutput(); err != nil {
		t.Fatalf("复制 node_modules 失败: %v %s", err, output)
	}

	launcher := filepath.Join(agentDir, "run-agent-host.sh")
	writeJSON(t, filepath.Join(dataDir, "agent_config.json"), map[string]any{
		"model":       "gpt-5.5",
		"hostCommand": launcher,
	})
	// 默认用占位密钥验证「连接信息来自本地模型配置」；需要真实回合时在启动前写入真实凭据，
	// 因为宿主只在启动时读取一次模型连接信息。
	modelID, modelURL, modelKey := "gpt-5.5", "https://relay.example.com/v1", "local-config-key"
	if os.Getenv("BEEFTV_TEST_REAL_TURN") == "1" {
		credentials := os.Getenv("BEEFTV_TEST_CREDENTIALS")
		if credentials == "" {
			t.Fatal("BEEFTV_TEST_REAL_TURN=1 需要 BEEFTV_TEST_CREDENTIALS")
		}
		raw, err := os.ReadFile(credentials)
		if err != nil {
			t.Fatal(err)
		}
		var cred struct {
			APIKey  string `json:"api_key"`
			BaseURL string `json:"base_url"`
			Model   string `json:"model"`
		}
		if err := json.Unmarshal(raw, &cred); err != nil {
			t.Fatal(err)
		}
		modelID, modelURL, modelKey = cred.Model, cred.BaseURL, cred.APIKey
	}
	// Issue #68: a models-only custom channel must feed the real host from the
	// persisted default text selection, without modelProfiles or database rows.
	modelConfig := map[string]any{
		"schemaVersion": 1, "revision": 1,
		"config": map[string]any{"apiKey": "", "textModel": "desktop-fixture::" + modelID,
			"channels": []any{map[string]any{"id": "desktop-fixture", "name": "Desktop fixture", "enabled": true,
				"apiKey": modelKey, "baseUrl": modelURL, "apiFormat": "openai",
				"models": []string{modelID}}}},
	}
	writeJSON(t, filepath.Join(dataDir, "local-model-config.json"), modelConfig)

	const launchToken = "desktop-chain-test-token"
	runtime, err := bootstrap.Open(t.Context(), bootstrap.Config{
		Profile:     bootstrap.ProfileDesktop,
		DataDir:     dataDir,
		ListenAddr:  "127.0.0.1:0",
		LaunchToken: launchToken,
		AutoMigrate: true,
	})
	if err != nil {
		t.Fatalf("打开桌面运行时失败: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("启动桌面运行时失败: %v", err)
	}
	t.Cleanup(func() { _ = runtime.Close(t.Context()) })

	baseURL := runtime.BaseURL()
	if !strings.HasPrefix(baseURL, "http://127.0.0.1:") {
		t.Fatalf("桌面运行时应在回环地址提供服务，得到 %q", baseURL)
	}

	// 无桌面令牌：整个 API 由启动令牌把关，直接拒绝。
	if code, _ := desktopRequest(t, baseURL+"/assistant/ui-session", http.MethodPost, launchToken, false); code != http.StatusForbidden {
		t.Fatalf("缺少桌面令牌应被拒绝，得到 %d", code)
	}

	// 仅出示桌面令牌签发 UI 会话：不需要 owner 凭据，也不需要开发引导开关。
	code, body := desktopRequest(t, baseURL+"/assistant/ui-session", http.MethodPost, launchToken, true, runtime.UIBootstrapToken())
	if code != http.StatusOK {
		t.Fatalf("凭桌面令牌签发 UI 会话失败：%d %s", code, body)
	}
	var session struct {
		Data struct {
			Token     string `json:"token"`
			Bootstrap struct {
				OwnerToken   bool `json:"ownerToken"`
				DevBootstrap bool `json:"devBootstrap"`
				DesktopShell bool `json:"desktopShell"`
			} `json:"bootstrap"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &session); err != nil {
		t.Fatal(err)
	}
	if session.Data.Token == "" || !session.Data.Bootstrap.DesktopShell {
		t.Fatalf("桌面令牌应作为签发依据，得到 %s", body)
	}
	if session.Data.Bootstrap.DevBootstrap || session.Data.Bootstrap.OwnerToken {
		t.Fatalf("不应依赖开发引导或 owner 凭据，得到 %s", body)
	}
	if os.Getenv("BEEFTV_UI_BOOTSTRAP") == "1" {
		t.Fatal("该用例必须在没有 BEEFTV_UI_BOOTSTRAP 的前提下运行")
	}

	// 模型连接信息必须来自应用已有的本地模型配置：进程内没有 BEEFTV_AGENT_API_KEY。
	// 启动链拉起自有子进程后，/assistant/status 在实例证明通过时才报 available。
	deadline := time.Now().Add(90 * time.Second)
	available := false
	health := ""
	for time.Now().Before(deadline) {
		code, body = desktopRequest(t, baseURL+"/assistant/status", http.MethodGet, launchToken, true)
		if code == http.StatusOK && strings.Contains(body, `"available":true`) {
			available = true
			health = body
			break
		}
		time.Sleep(time.Second)
	}
	if !available {
		t.Fatalf("宿主未由启动链拉起，最后一次响应：%d %s", code, body)
	}
	var status struct {
		Data struct {
			Model struct {
				ID        string `json:"id"`
				ChannelID string `json:"channelId"`
			} `json:"model"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(health), &status); err != nil {
		t.Fatal(err)
	}
	if status.Data.Model.ID != modelID || status.Data.Model.ChannelID != "desktop-fixture" {
		t.Fatalf("助手状态没有投影选中的渠道模型：%s", health)
	}
	if raw, err := os.ReadFile(filepath.Join(dataDir, "agent-requests.jsonl")); err == nil && len(strings.TrimSpace(string(raw))) > 0 {
		t.Fatalf("启动链验收不得产生模型请求：%s", raw)
	}

	// 外部客户端（CLI/MCP）接同一个桌面实例：桌面形态的 API 由启动令牌把关，
	// 客户端必须同时出示「桌面启动令牌（过守卫）」与「已登记客户端凭据（定能力）」。
	// 这一步是零模型只读验证：读工具可用，写工具被只读客户端拒绝。
	if cliBinary := os.Getenv("BEEFTV_TEST_CLI"); cliBinary != "" {
		// 客户端登记按现有合同需要 owner 凭据（本机用户可读，0600）；桌面令牌只负责过守卫。
		ownerRaw, err := os.ReadFile(filepath.Join(dataDir, "agent_owner_token"))
		if err != nil {
			t.Fatal(err)
		}
		ownerToken := strings.TrimSpace(string(ownerRaw))
		code, body = desktopRequestOwning(t, baseURL+"/ops/clients", launchToken, ownerToken,
			map[string]any{"label": "desktop-cli-check", "mode": "read-only"})
		if code != http.StatusOK {
			t.Fatalf("登记只读客户端失败（需要 owner + 桌面令牌）：%d %s", code, body)
		}
		var registered struct {
			Data struct {
				Client struct {
					ID string `json:"id"`
				} `json:"client"`
				Token string `json:"token"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(body), &registered); err != nil {
			t.Fatal(err)
		}
		if registered.Data.Client.ID == "" || registered.Data.Token == "" {
			t.Fatalf("登记响应缺少客户端凭据：%s", body)
		}

		runCli := func(args ...string) (int, string) {
			command := exec.Command(cliBinary, args...)
			command.Env = append(os.Environ(),
				"BEEFTV_BASE_URL="+baseURL,
				"BEEFTV_DESKTOP_TOKEN=",
				"BEEFTV_CLIENT_ID="+registered.Data.Client.ID,
				"BEEFTV_CLIENT_TOKEN="+registered.Data.Token,
			)
			output, err := command.CombinedOutput()
			exitCode := 0
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else if err != nil {
				t.Fatalf("执行 CLI 失败: %v", err)
			}
			return exitCode, string(output)
		}

		// 只读列能力：能连上同一个桌面实例（守卫通过 + 客户端身份被接受）。
		exitCode, output := runCli("ops", "list", "--read-only", "--json")
		if exitCode != 0 || !strings.Contains(output, "canvas.get") {
			t.Fatalf("CLI 应能通过桌面令牌读取同一实例的能力列表：exit=%d %s", exitCode, truncate(output, 300))
		}
		// 没有登记凭据时拒绝；外部客户端不持有桌面壳的令牌。
		command := exec.Command(cliBinary, "ops", "list", "--read-only", "--json")
		command.Env = append(os.Environ(), "BEEFTV_BASE_URL="+baseURL,
			"BEEFTV_DESKTOP_TOKEN=", "BEEFTV_CLIENT_ID="+registered.Data.Client.ID, "BEEFTV_CLIENT_TOKEN=invalid")
		if err := command.Run(); err == nil {
			t.Fatal("无效客户端凭据不应能访问桌面实例")
		}
		// 只读客户端写操作仍被能力层拒绝。
		exitCode, output = runCli("canvas", "node", "update", "--canvas", "any", "--node", "n1",
			"--expected-revision", "1", "--content", "x", "--op-id", "desktop-cli-write", "--json")
		if exitCode == 0 || !strings.Contains(output, "read_only") {
			t.Fatalf("只读客户端写操作应被拒绝：exit=%d %s", exitCode, truncate(output, 300))
		}
		t.Logf("CLI 桌面接线通过：读成功、无令牌被拒、只读写被拒")
	}

	// 最小文字读写（默认跳过，避免测试依赖真实模型）：设置 BEEFTV_TEST_REAL_TURN=1
	// 与 BEEFTV_TEST_CREDENTIALS=<beefapi 凭据 json> 时，用真实模型走一次
	// 「读画布 + 改一个节点字段」，证明发行形态下的助手链路真的能读写。
	if os.Getenv("BEEFTV_TEST_REAL_TURN") == "1" {
		fixture := "desktop-chain-fixture"
		code, body := desktopRequestWith(t, baseURL+"/canvas-projects/"+fixture, http.MethodPut, launchToken, true, map[string]any{
			"project": map[string]any{"id": fixture, "revision": 0, "title": "发行链夹具",
				"nodes": []any{map[string]any{"id": "n1", "type": "text", "title": "发行链节点",
					"position": map[string]any{"x": 120.0, "y": 120.0}, "width": 320.0, "height": 200.0,
					"metadata": map[string]any{"content": "ORIGINAL-CONTENT"}}},
				"connections": []any{}},
		})
		if code != http.StatusOK {
			t.Fatalf("创建夹具画布失败：%d %s", code, body)
		}

		sessionToken := session.Data.Token
		chatBody := map[string]any{"canvasId": fixture,
			"message": "请读取当前画布，然后用 canvas.node.update 把节点 n1 的 content 改成 DESKTOP-CHAIN-OK，最后用一句话确认。"}
		encoded, _ := json.Marshal(chatBody)
		request, err := http.NewRequest(http.MethodPost, baseURL+"/assistant/chat", strings.NewReader(string(encoded)))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Beeftv-Ui-Session", sessionToken)
		response, err := (&http.Client{Timeout: 5 * time.Minute}).Do(request)
		if err != nil {
			t.Fatalf("对话请求失败: %v", err)
		}
		defer response.Body.Close()
		stream, _ := io.ReadAll(response.Body)
		turnEnd := ""
		toolCalls := []string{}
		for _, line := range strings.Split(string(stream), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" {
				continue
			}
			var payload struct {
				Type      string `json:"type"`
				Reply     string `json:"reply"`
				Error     string `json:"error"`
				ToolCalls []struct {
					Tool string `json:"tool"`
				} `json:"toolCalls"`
			}
			if json.Unmarshal([]byte(trimmed), &payload) != nil || payload.Type != "turn_end" {
				continue
			}
			if payload.Error != "" {
				t.Fatalf("回合失败: %s", payload.Error)
			}
			turnEnd = payload.Reply
			for _, call := range payload.ToolCalls {
				toolCalls = append(toolCalls, call.Tool)
			}
		}
		if strings.TrimSpace(turnEnd) == "" {
			t.Fatalf("回合没有非空回复；工具=%v", toolCalls)
		}
		code, body = desktopRequest(t, baseURL+"/canvas-projects/"+fixture, http.MethodGet, launchToken, true)
		if code != http.StatusOK || !strings.Contains(body, "DESKTOP-CHAIN-OK") {
			t.Fatalf("助手没有把内容写入画布：%d %s", code, truncate(body, 400))
		}
		t.Logf("最小文字读写通过：reply=%q tools=%v", truncate(turnEnd, 120), toolCalls)
	}

	// 关闭运行时：本进程启动的宿主必须随之退出（生命周期管道 EOF）。
	if err := runtime.Close(t.Context()); err != nil {
		t.Fatalf("关闭运行时失败: %v", err)
	}
	deadline = time.Now().Add(5 * time.Second)
	closedClient := &http.Client{Timeout: time.Second}
	for time.Now().Before(deadline) {
		_, err := closedClient.Get(baseURL + "/assistant/status")
		if err != nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("关闭运行时后后端仍在响应")
}

func TestBundledAgentHostCommandForAppLayout(t *testing.T) {
	// 打包布局寻址由 assistantruntime 包负责；这里只保证 bootstrap 侧不引入别的路径假设。
	workspaceRoot := filepath.Clean(filepath.Join("..", "..", ".."))
	if _, err := os.Stat(filepath.Join(workspaceRoot, "agent-host", "run-agent-host.sh")); err != nil {
		t.Skipf("随包启动器不存在: %v", err)
	}
}

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	data, err := os.ReadFile(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(to, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

// desktopRequestOwning 同时出示桌面令牌（过守卫）与 owner 凭据（登记客户端）。
func desktopRequestOwning(t *testing.T, url, desktopToken, ownerToken string, payload any) (int, string) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, url, strings.NewReader(string(encoded)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Desktop-Token", desktopToken)
	request.Header.Set("X-Beeftv-Owner", ownerToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, err.Error()
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 8<<10))
	return response.StatusCode, string(body)
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func desktopRequestWith(t *testing.T, url, method, token string, withToken bool, payload any) (int, string) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(method, url, strings.NewReader(string(encoded)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if withToken {
		request.Header.Set("X-Desktop-Token", token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, err.Error()
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 8<<10))
	return response.StatusCode, string(body)
}

func desktopRequest(t *testing.T, url, method, token string, withToken bool, uiToken ...string) (int, string) {
	t.Helper()
	request, err := http.NewRequest(method, url, strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if len(uiToken) > 0 {
		request.Header.Set("X-Beeftv-UI-Bootstrap", uiToken[0])
	}
	if withToken {
		request.Header.Set("X-Desktop-Token", token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, err.Error()
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 8<<10))
	return response.StatusCode, string(body)
}
