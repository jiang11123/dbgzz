package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/runtimeinfo"
)

// 二级子命令必须被校验：缺失/未知不能 panic，也不能被当成 update/create 发出去。
func TestCanvasSubcommandGuards(t *testing.T) {
	var calls int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"ok":true},"msg":"ok"}`))
	}))
	defer server.Close()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	t.Setenv("BEEFTV_OWNER_TOKEN", "owner-token-for-test")

	cases := [][]string{
		{"canvas", "node"},
		{"canvas", "node", "delete", "--canvas", "c1", "--node", "n1"},
		{"canvas", "nodes"},
		{"canvas", "nodes", "delete", "--canvas", "c1"},
		{"canvas", "edge"},
		{"canvas", "edge", "delete", "--canvas", "c1"},
	}
	for _, args := range cases {
		err := run(args)
		if err == nil {
			t.Fatalf("%v 应返回用法错误", args)
		}
		cliErr, ok := err.(*cliError)
		if !ok || cliErr.code != exitUsage {
			t.Fatalf("%v 应为 exitUsage，得到 %v", args, err)
		}
	}
	if calls != 0 {
		t.Fatalf("用法错误不应发出任何 HTTP 请求，实际 %d 次", calls)
	}
}

// -h/--help 属于正常退出，不是错误。
func TestHelpFlagExitsCleanly(t *testing.T) {
	if err := run([]string{"canvas", "node", "update", "--help"}); err != nil {
		t.Fatalf("--help 应正常退出，得到 %v", err)
	}
	if err := run([]string{"--help"}); err != nil {
		t.Fatalf("顶层 --help 应正常退出，得到 %v", err)
	}
	if err := run([]string{"-h"}); err != nil {
		t.Fatalf("顶层 -h 应正常退出，得到 %v", err)
	}
}

// 非法 flag / 非法取值必须是可读的用法错误：flagError 曾经递归调用自己，
// 会把栈打爆而不是给出错误；同时绝不能在解析失败后还发出写入请求。
func TestInvalidFlagsAreUsageErrorsWithoutWrites(t *testing.T) {
	var calls int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"ok":true},"msg":"ok"}`))
	}))
	defer server.Close()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	t.Setenv("BEEFTV_OWNER_TOKEN", "owner-token-for-test")

	cases := [][]string{
		{"canvas", "node", "update", "--canvas", "c1", "--node", "n1", "--expected-revision", "1", "--op-id", "op-1", "--nope", "x"},
		{"canvas", "node", "update", "--canvas", "c1", "--node", "n1", "--expected-revision", "not-a-number", "--op-id", "op-1", "--prompt", "p"},
		{"canvas", "nodes", "create", "--canvas", "c1", "--expected-revision", "abc", "--op-id", "op-2", "--node", "标题:image"},
		{"canvas", "edge", "create", "--canvas", "c1", "--from", "a", "--to", "b", "--expected-revision", "1.5", "--op-id", "op-3"},
	}
	for _, args := range cases {
		err := run(args)
		if err == nil {
			t.Fatalf("%v 应返回用法错误", args)
		}
		cliErr, ok := err.(*cliError)
		if !ok {
			t.Fatalf("%v 应为 *cliError，得到 %T(%v)", args, err, err)
		}
		if cliErr.code != exitUsage {
			t.Fatalf("%v 应为 exitUsage，得到 %d", args, cliErr.code)
		}
		if cliErr.reason != "bad_flags" {
			t.Fatalf("%v 的 reason 应为 bad_flags，得到 %q", args, cliErr.reason)
		}
	}
	if calls != 0 {
		t.Fatalf("flag 解析失败不应发出任何 HTTP 请求，实际 %d 次", calls)
	}
}

// --read-only 必须是本地收紧，而不是把权限判断外包给服务端查询参数：
// 即使服务端返回了写操作，只读模式也不能把它们交给 MCP 或调用方。
func TestReadOnlyTightensOperationSetLocally(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// 故意返回完整集合（含写操作），模拟服务端未按身份收紧的情况。
		_, _ = w.Write([]byte(`{"code":0,"data":{"ops":[
			{"id":"canvas.get","summary":"读画布","readOnly":true,"scope":"canvas"},
			{"id":"canvas.node.update","summary":"改节点","readOnly":false,"scope":"canvas"},
			{"id":"canvas.nodes.create","summary":"建节点","readOnly":false,"scope":"canvas"},
			{"id":"asset.list","summary":"列素材","readOnly":true,"scope":"workspace_read"}
		]},"msg":"ok"}`))
	}))
	defer server.Close()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	t.Setenv("BEEFTV_OWNER_TOKEN", "owner-token-for-test")

	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	all, err := c.listOps(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 4 {
		t.Fatalf("非只读模式应拿到全部操作，实际 %d", len(all))
	}
	tightened, err := c.listOps(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(tightened) != 2 {
		t.Fatalf("只读模式应只保留只读操作，实际 %d", len(tightened))
	}
	for _, op := range tightened {
		if !op.ReadOnly {
			t.Fatalf("只读模式仍暴露写操作 %s", op.ID)
		}
	}
}

// 桌面形态的 API 由桌面启动令牌把关：CLI/MCP 要接同一个桌面工作区就必须出示它，
// 否则只能连独立 server 形态的工作区。令牌只用于通过守卫，不改变能力模式。
func TestDesktopTokenHeaderIsSentWhenConfigured(t *testing.T) {
	var seen string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("X-Desktop-Token")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"ops":[]},"msg":"ok"}`))
	}))
	defer server.Close()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	t.Setenv("BEEFTV_OWNER_TOKEN", "owner-token-for-test")
	t.Setenv("BEEFTV_DESKTOP_TOKEN", "desktop-shell-token")

	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.listOps(true); err != nil {
		t.Fatal(err)
	}
	if seen != "desktop-shell-token" {
		t.Fatalf("应发送桌面启动令牌头，得到 %q", seen)
	}

	// 未配置时不发送该头，独立 server 形态不受影响。
	seen = ""
	t.Setenv("BEEFTV_DESKTOP_TOKEN", "")
	c2, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c2.listOps(true); err != nil {
		t.Fatal(err)
	}
	if seen != "" {
		t.Fatalf("未配置时不应发送桌面启动令牌头，得到 %q", seen)
	}
}

// 运行时发现：没有 BEEFTV_BASE_URL 时，CLI 要从工作区对应的运行时描述文件找到
// 正在运行的桌面工作区，而不是去猜一个固定端口。外部 Agent 靠这条路径接入，
// 手里只有自己的客户端凭据，没有桌面启动令牌。
func TestBaseURLComesFromRuntimeDiscovery(t *testing.T) {
	t.Setenv("USERPROFILE", t.TempDir())
	var seenClient, seenAuth, seenDesktop string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenClient = r.Header.Get("X-Beeftv-Client")
		seenAuth = r.Header.Get("Authorization")
		seenDesktop = r.Header.Get("X-Desktop-Token")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"ops":[]},"msg":"ok"}`))
	}))
	defer server.Close()

	dataDir := t.TempDir()
	if err := runtimeinfo.Write(dataDir, server.URL, "v-test"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BEEFTV_BASE_URL", "")
	t.Setenv("BEEFTV_DATA_DIR", dataDir)
	t.Setenv("BEEFTV_OWNER_TOKEN", "")
	t.Setenv("BEEFTV_DESKTOP_TOKEN", "")
	t.Setenv("BEEFTV_CLIENT_ID", "client-test")
	t.Setenv("BEEFTV_CLIENT_TOKEN", "client-token-test")

	base, source := resolveBaseURL()
	if base != server.URL {
		t.Fatalf("应连上发现到的地址，得到 %q", base)
	}
	if source == "" {
		t.Fatal("应说明地址来源")
	}
	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.listOps(true); err != nil {
		t.Fatal(err)
	}
	if seenClient != "client-test" || seenAuth != "Bearer client-token-test" {
		t.Fatalf("应只带客户端自己的凭据，得到 %q / %q", seenClient, seenAuth)
	}
	if seenDesktop != "" {
		t.Fatalf("外部客户端不该带桌面启动令牌，得到 %q", seenDesktop)
	}
}

// 运行时文件里的进程已经退出：视为过期，不猜测任何默认端口。
func TestStaleRuntimeFileIsIgnored(t *testing.T) {
	t.Setenv("USERPROFILE", t.TempDir())
	dataDir := t.TempDir()
	if err := runtimeinfo.Write(dataDir, "http://127.0.0.1:59999/api", "v-old"); err != nil {
		t.Fatal(err)
	}
	info, err := runtimeinfo.Load(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	info.PID = 987654321
	stale, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	path, err := runtimeinfo.Path(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, stale, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BEEFTV_BASE_URL", "")
	t.Setenv("BEEFTV_DATA_DIR", dataDir)
	base, _ := resolveBaseURL()
	if base != "" {
		t.Fatalf("过期运行时文件应被忽略，得到 %q", base)
	}
	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.listOps(false)
	if cliErr, ok := err.(*cliError); !ok || cliErr.reason != "runtime_not_found" {
		t.Fatalf("expected actionable missing runtime error, got %v", err)
	}
}

// 显式 BEEFTV_BASE_URL 优先于自动发现。
func TestExplicitBaseURLWinsOverDiscovery(t *testing.T) {
	t.Setenv("USERPROFILE", t.TempDir())
	dataDir := t.TempDir()
	if err := runtimeinfo.Write(dataDir, "http://127.0.0.1:53999/api", "v-test"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BEEFTV_DATA_DIR", dataDir)
	t.Setenv("BEEFTV_BASE_URL", "http://127.0.0.1:8080/api")
	base, source := resolveBaseURL()
	if base != "http://127.0.0.1:8080/api" || source != "BEEFTV_BASE_URL" {
		t.Fatalf("显式地址应优先，得到 %q（%s）", base, source)
	}
}
