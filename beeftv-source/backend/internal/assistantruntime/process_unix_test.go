//go:build unix

package assistantruntime

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// 应用关闭必须带走「本 Host 启动的」宿主子进程，且绝不能碰无关进程。
func TestStopContextDoesNotReapOutsider(t *testing.T) {
	outsider := startOutsider(t)
	outsiderAlive := func() bool { return outsider.Process.Signal(syscall.Signal(0)) == nil }

	host := fixtureHost(t, "http")
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", "desktop-shell-token"); err != nil {
		t.Fatalf("启动测试宿主失败: %v", err)
	}
	childPID := host.PID()
	if childPID == 0 || !host.Running() {
		t.Fatal("子进程应处于运行状态")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := host.StopContext(ctx); err != nil {
		t.Fatalf("关闭钩子应成功停止本 Host 启动的宿主: %v", err)
	}
	if !waitUntil(5*time.Second, func() bool { return syscall.Kill(childPID, syscall.Signal(0)) != nil }) {
		t.Fatalf("宿主子进程 %d 在关闭后仍在运行", childPID)
	}
	if !outsiderAlive() {
		t.Fatal("关闭钩子不应影响不是它启动的进程")
	}
}

func TestParentSIGKILLClosesLifetimePipeAndChildExits(t *testing.T) {
	dataDir := t.TempDir()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), fixtureEnv+"=supervisor", "BEEFTV_SUPERVISOR_DATA="+dataDir)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	endpointFile := filepath.Join(dataDir, "endpoint.txt")
	if !waitUntil(12*time.Second, func() bool {
		raw, err := os.ReadFile(endpointFile)
		return err == nil && strings.TrimSpace(string(raw)) != ""
	}) {
		t.Fatal("supervisor fixture 未发布端点")
	}
	endpoint := strings.TrimSpace(mustReadFile(t, endpointFile))
	childPID, err := strconv.Atoi(strings.TrimSpace(mustReadFile(t, filepath.Join(dataDir, "child-pid.txt"))))
	if err != nil || childPID <= 0 {
		t.Fatalf("child pid %d %v", childPID, err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_, _ = cmd.Process.Wait()
	if !waitUntil(5*time.Second, func() bool {
		return syscall.Kill(childPID, syscall.Signal(0)) != nil
	}) {
		t.Fatalf("父进程 SIGKILL 后子进程 %d 仍在运行", childPID)
	}
	resp, getErr := http.Get(endpoint + "/health")
	if getErr == nil {
		resp.Body.Close()
		t.Fatal("旧子进程不得在父进程被杀后继续服务")
	}
}

func mustReadFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
