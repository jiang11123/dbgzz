package assistantruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"infinite-canvas/backend/internal/assistant"
)

const fixtureEnv = "BEEFTV_ASSISTANT_RUNTIME_FIXTURE"

var platformProcessFixtures = map[string]func() int{}

func TestMain(m *testing.M) {
	if mode := strings.TrimSpace(os.Getenv(fixtureEnv)); mode != "" {
		os.Exit(runProcessFixture(mode))
	}
	os.Exit(m.Run())
}

func runProcessFixture(mode string) int {
	switch mode {
	case "sleep":
		waitForStopSignal()
		return 0
	case "exit0":
		return 0
	case "crash":
		return 2
	case "fail-listen":
		return 2
	case "http":
		return runHTTPFixture()
	case "supervisor":
		return runSupervisorFixture()
	default:
		if run := platformProcessFixtures[mode]; run != nil {
			return run()
		}
		fmt.Fprintf(os.Stderr, "unknown fixture %q\n", mode)
		return 1
	}
}

func runHTTPFixture() int {
	nonce := os.Getenv("BEEFTV_AGENT_INSTANCE_NONCE")
	if dataDir := os.Getenv("BEEFTV_AGENT_DATA_DIR"); dataDir != "" {
		_ = os.WriteFile(filepath.Join(dataDir, "child-env.txt"), []byte(strings.Join(os.Environ(), "\n")), 0o600)
		_ = os.WriteFile(filepath.Join(dataDir, "child-pid.txt"), []byte(strconv.Itoa(os.Getpid())), 0o600)
	}
	go func() {
		buf := make([]byte, 1)
		for {
			if _, err := os.Stdin.Read(buf); err != nil {
				fmt.Fprintf(os.Stderr, "fixture lifetime stdin ended: %v\n", err)
				os.Exit(0)
			}
		}
	}()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if nonce != "" && r.Header.Get(InstanceHeader) != nonce {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"ok":false,"reason":"instance_mismatch"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		busy := os.Getenv("BEEFTV_AGENT_BUSY") == "1"
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "busy": busy, "model": os.Getenv("BEEFTV_AGENT_MODEL"),
			"instance": InstanceProof(nonce),
		})
	})
	if fdRaw := strings.TrimSpace(os.Getenv("BEEFTV_AGENT_LISTEN_FD")); fdRaw != "" {
		fd, err := strconv.Atoi(fdRaw)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		listener, err := net.FileListener(os.NewFile(uintptr(fd), "listen"))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if err := http.Serve(listener, mux); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}
	port := strings.TrimSpace(os.Getenv("BEEFTV_AGENT_PORT"))
	if port == "" {
		fmt.Fprintln(os.Stderr, "missing BEEFTV_AGENT_PORT")
		return 2
	}
	fmt.Fprintln(os.Stderr, "fixture listening on allocated loopback port")
	if err := http.ListenAndServe("127.0.0.1:"+port, mux); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func runSupervisorFixture() int {
	dataDir := os.Getenv("BEEFTV_SUPERVISOR_DATA")
	config := HostConfig{HostCommand: os.Args[0], HostArgs: []string{}}
	encoded, err := json.Marshal(config)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := os.WriteFile(filepath.Join(dataDir, hostConfigFile), encoded, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	host := New(Options{
		DataDir:      dataDir,
		ReadyTimeout: 8 * time.Second,
		Environ: func() []string {
			out := make([]string, 0)
			for _, entry := range os.Environ() {
				if strings.HasPrefix(entry, fixtureEnv+"=") {
					continue
				}
				out = append(out, entry)
			}
			return append(out, fixtureEnv+"=http")
		},
	})
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", ""); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	_ = os.WriteFile(filepath.Join(dataDir, "child-pid.txt"), []byte(strconv.Itoa(host.PID())), 0o600)
	// Publish readiness last; readers must never observe the PID file mid-truncate.
	_ = os.WriteFile(filepath.Join(dataDir, "endpoint.txt"), []byte(host.Endpoint()), 0o600)
	select {}
}

func fixtureProvider() assistant.Provider {
	return assistant.Provider{Model: "m", BaseURL: "https://example.invalid/v1", APIKey: "k", Protocol: "chat-completion"}
}

func waitForStopSignal() {
	notified := make(chan os.Signal, 1)
	signal.Notify(notified, os.Interrupt, syscall.SIGTERM)
	<-notified
}

func fixtureHost(t *testing.T, mode string) *Host {
	t.Helper()
	dataDir := t.TempDir()
	config := HostConfig{HostCommand: os.Args[0], HostArgs: []string{}}
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, hostConfigFile), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	host := New(Options{
		DataDir:      dataDir,
		ReadyTimeout: 8 * time.Second,
		Environ: func() []string {
			return append(os.Environ(), fixtureEnv+"="+mode)
		},
	})
	t.Cleanup(func() { _ = host.Stop() })
	return host
}

func waitUntil(timeout time.Duration, ok func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ok() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return ok()
}

func TestHostStopReapsOwnChild(t *testing.T) {
	host := fixtureHost(t, "http")
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", "desktop-shell-token"); err != nil {
		t.Fatalf("启动测试宿主失败: %v", err)
	}
	if host.PID() == 0 || !host.Running() {
		t.Fatal("子进程应处于运行状态")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := host.StopContext(ctx); err != nil {
		t.Fatalf("关闭钩子应成功停止本 Host 启动的宿主: %v", err)
	}
	if host.Running() {
		t.Fatal("停止后不应仍报告运行中")
	}
	if err := host.StopContext(context.Background()); err != nil {
		t.Fatalf("无自有宿主时钩子应为 no-op，实际 %v", err)
	}
	if launched, err := host.Ensure(fixtureProvider(), "http://127.0.0.1:18090/api", "desktop-shell-token", true); err == nil || launched || host.Running() {
		t.Fatalf("应用退出期间的状态查询不得重启宿主：launched=%v err=%v", launched, err)
	}
}

func TestHostRestartReplacesChild(t *testing.T) {
	host := fixtureHost(t, "http")
	provider := fixtureProvider()
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	first := host.PID()
	if first == 0 {
		t.Fatal("未记录子进程 PID")
	}
	if err := host.Restart(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("重启失败: %v", err)
	}
	if !host.Running() {
		t.Fatal("重启后应有新的子进程")
	}
	second := host.PID()
	if second == 0 || second == first {
		t.Fatalf("重启应换新 PID，first=%d second=%d", first, second)
	}
}

func TestHostCrashIsReapedAndCanRelaunch(t *testing.T) {
	host := fixtureHost(t, "crash")
	provider := fixtureProvider()
	for attempt := 0; attempt < 2; attempt++ {
		if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err == nil {
			t.Fatal("崩溃子进程不得被报告为已就绪")
		}
		if host.Running() || host.Endpoint() != "" {
			t.Fatal("崩溃子进程应被回收且不得留下可复用端点")
		}
	}
}

func TestSeparateHostsDoNotShareProcessOwnership(t *testing.T) {
	first := fixtureHost(t, "http")
	second := fixtureHost(t, "http")
	provider := fixtureProvider()
	if err := first.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	if err := second.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	firstPID, secondPID := first.PID(), second.PID()
	if firstPID == 0 || secondPID == 0 || firstPID == secondPID {
		t.Fatalf("两个 Host 应各自持有子进程 first=%d second=%d", firstPID, secondPID)
	}
	if err := first.Stop(); err != nil {
		t.Fatal(err)
	}
	if first.Running() {
		t.Fatal("停止 first 后其自身不应仍在运行")
	}
	if !second.Running() || second.PID() != secondPID {
		t.Fatal("停止 first 不得带走 second 的子进程")
	}
}

func TestEnsureRestartsWhenFingerprintChangesAndIdle(t *testing.T) {
	host := fixtureHost(t, "http")
	original := fixtureProvider()
	if err := host.Launch(original, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	first := host.PID()
	updated := original
	updated.APIKey = "rotated"
	launched, err := host.Ensure(updated, "http://127.0.0.1:18090/api", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if !launched {
		t.Fatal("空闲且指纹变化时应重启")
	}
	if host.PID() == first {
		t.Fatal("指纹变化重启应换新 PID")
	}
	launched, err = host.Ensure(updated, "http://127.0.0.1:18090/api", "", true)
	if err != nil || launched {
		t.Fatalf("相同指纹且在跑时 Ensure 应为 no-op launched=%v err=%v", launched, err)
	}
}

func TestConcurrentLifecycleLeavesSingleOwnedChild(t *testing.T) {
	host := fixtureHost(t, "http")
	provider := fixtureProvider()
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	updated := provider
	updated.APIKey = "rotated"
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			_, _ = host.Ensure(provider, "http://127.0.0.1:18090/api", "", true)
		}()
		go func() {
			defer wg.Done()
			_, _ = host.Ensure(updated, "http://127.0.0.1:18090/api", "", false)
		}()
		go func() {
			defer wg.Done()
			_ = host.Restart(provider, "http://127.0.0.1:18090/api", "")
		}()
	}
	wg.Wait()
	if err := host.Stop(); err != nil {
		t.Fatal(err)
	}
	if host.Running() {
		t.Fatal("并发 Ensure/Restart 结束后 Stop 必须带走本 Host 的子进程")
	}
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("单次 Wait 约束在并发后仍应可再次启动: %v", err)
	}
	if !host.Running() {
		t.Fatal("再次启动应有子进程")
	}
}

func TestEnsureDoesNotRestartBusyHostOnFingerprintChange(t *testing.T) {
	host := fixtureHost(t, "http")
	original := fixtureProvider()
	if err := host.Launch(original, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	first := host.PID()
	updated := original
	updated.Model = "other"
	launched, err := host.Ensure(updated, "http://127.0.0.1:18090/api", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if launched {
		t.Fatal("非空闲时不得因指纹变化重启")
	}
	if host.PID() != first {
		t.Fatal("非空闲时 PID 应保持不变")
	}
}

func startOutsider(t *testing.T) *exec.Cmd {
	t.Helper()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("ping", "-n", "120", "127.0.0.1")
	} else {
		cmd = exec.Command("sleep", "120")
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	return cmd
}

func startForeignHealth(t *testing.T) (addr string, hits *int32) {
	t.Helper()
	var n int32
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"busy":false,"model":"foreign","instance":"not-ours"}`))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return "http://" + listener.Addr().String(), &n
}

func TestFreshHostDoesNotAdoptForeignHealthyListener(t *testing.T) {
	foreign, hits := startForeignHealth(t)
	t.Setenv("BEEFTV_AGENT_HOST_URL", foreign)
	t.Setenv("BEEFTV_AGENT_PORT", "18500")
	host := New(Options{DataDir: t.TempDir()})
	if host.Endpoint() != "" || host.Running() {
		t.Fatal("新构造的 Host 不得认领已有监听器")
	}
	health := host.Probe(context.Background())
	if health.OK {
		t.Fatal("Probe 不得把外部 /health 当成自有子进程")
	}
	if err := host.Stop(); err != nil {
		t.Fatal(err)
	}
	if *hits != 0 {
		t.Fatalf("Stop/Probe 不得打到外部监听器，hits=%d", *hits)
	}
	req, err := http.NewRequest(http.MethodGet, foreign+"/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatal("外部监听器必须仍在运行")
	}
}

func TestLaunchPinsPortAndDropsSpoofedOwnerOpenAI(t *testing.T) {
	host := fixtureHost(t, "http")
	host.opts.Environ = func() []string {
		return []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + os.Getenv("HOME"),
			fixtureEnv + "=http",
			"BEEFTV_AGENT_PORT=18500",
			"BEEFTV_OWNER_TOKEN=stolen-owner",
			"BEEFTV_AGENT_HOST_TOKEN=stolen-host",
			"OPENAI_API_KEY=sk-openai",
			"ANTHROPIC_API_KEY=sk-ant",
		}
	}
	host.opts.HostToken = func() string { return "pinned-host" }
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(host.dataDir(), "child-env.txt"))
	if err != nil {
		t.Fatal(err)
	}
	childEnv := strings.Split(string(raw), "\n")
	if port := envValue(childEnv, "BEEFTV_AGENT_PORT"); port == "" || port == "18500" {
		t.Fatalf("子进程 PORT 必须是监督器钉死的实例端口，得到 %q", port)
	}
	if envValue(childEnv, "BEEFTV_OWNER_TOKEN") != "" {
		t.Fatal("子进程不得看到 OWNER_TOKEN")
	}
	if envValue(childEnv, "BEEFTV_AGENT_HOST_TOKEN") != "pinned-host" {
		t.Fatalf("子进程宿主凭据应被覆盖，得到 %q", envValue(childEnv, "BEEFTV_AGENT_HOST_TOKEN"))
	}
	if envHasKey(childEnv, "OPENAI_API_KEY") || envHasKey(childEnv, "ANTHROPIC_API_KEY") {
		t.Fatal("子进程不得继承 OPENAI/ANTHROPIC 密钥")
	}
	if host.Endpoint() == "http://127.0.0.1:18500" {
		t.Fatal("端点不得落在继承的 18500")
	}
}

func TestRestartFailureDoesNotReportSuccessOrKeepEndpoint(t *testing.T) {
	host := fixtureHost(t, "http")
	provider := fixtureProvider()
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	if host.Endpoint() == "" {
		t.Fatal("启动成功后必须暴露自有端点")
	}
	host.opts.Environ = func() []string {
		return append(os.Environ(), fixtureEnv+"=fail-listen")
	}
	if err := host.Restart(provider, "http://127.0.0.1:18090/api", ""); err == nil {
		t.Fatal("就绪失败的重启不得报告成功")
	}
	if host.Running() || host.Endpoint() != "" {
		t.Fatal("重启失败后不得留下可复用端点")
	}
}

func TestRelaunchDoesNotTalkToOldChild(t *testing.T) {
	host := fixtureHost(t, "http")
	provider := fixtureProvider()
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	firstPID := host.PID()
	firstURL := host.Endpoint()
	if firstPID == 0 || firstURL == "" {
		t.Fatal("需要已就绪的第一代子进程")
	}
	if err := host.Restart(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	if host.PID() == firstPID || host.Endpoint() == firstURL {
		t.Fatalf("重启必须换新实例 pid=%d/%d url=%s/%s", firstPID, host.PID(), firstURL, host.Endpoint())
	}
	resp, err := http.Get(firstURL + "/health")
	if err == nil {
		resp.Body.Close()
		t.Fatal("旧子进程不得继续响应")
	}
}

func TestNewHostCannotAdoptPreviousEndpoint(t *testing.T) {
	first := fixtureHost(t, "http")
	provider := fixtureProvider()
	if err := first.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	owned := first.Endpoint()
	second := New(Options{DataDir: t.TempDir()})
	t.Cleanup(func() { _ = second.Stop() })
	if second.Endpoint() != "" || second.Probe(context.Background()).OK {
		t.Fatal("另一个 Host 不得认领前一个实例的端点")
	}
	if err := first.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := http.Get(owned + "/health"); err == nil {
		t.Fatal("停止后旧端点不得仍可访问")
	}
}

func TestProbeRejectsHealthyListenerWithoutMatchingInstance(t *testing.T) {
	foreign, hits := startForeignHealth(t)
	host := New(Options{DataDir: t.TempDir()})
	host.TestingUseOwnedEndpoint(foreign, "owned-nonce-value", "fp")
	health := host.Probe(context.Background())
	if health.OK {
		t.Fatal("实例证明不匹配时不得把外部 /health 当成自有子进程")
	}
	if *hits == 0 {
		t.Fatal("Probe 应打到注入的测试端点并拒绝证明")
	}
	if strings.Contains(fmt.Sprintf("%#v", health), "owned-nonce-value") {
		t.Fatal("Probe 结果不得包含实例 nonce")
	}
}

func TestOwnedHealthJSONOmitsNonce(t *testing.T) {
	host := fixtureHost(t, "http")
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	health := host.Probe(context.Background())
	if !health.OK || health.Instance == "" {
		t.Fatalf("自有子进程应通过实例证明: %#v", health)
	}
	req, err := host.NewChildRequest(context.Background(), http.MethodGet, "/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	nonce := req.Header.Get(InstanceHeader)
	if nonce == "" {
		t.Fatal("子进程请求必须带实例 nonce 头")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), nonce) || strings.Contains(fmt.Sprintf("%#v", health), nonce) {
		t.Fatalf("health JSON 或探测结果含 nonce: %s", body)
	}
	if health.Instance == nonce {
		t.Fatal("公开 instance 字段必须是证明而不是 nonce")
	}
}
