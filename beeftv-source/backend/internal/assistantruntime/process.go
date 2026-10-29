package assistantruntime

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const defaultReadyTimeout = 20 * time.Second

// supervisor 持有本实例启动的子进程、回环端点与实例 nonce。
// 端点只在本进程就绪且 health 证明 nonce 之后才暴露；绝不把全局端口或别人的 PID 当成所有权。
type supervisor struct {
	mu          sync.Mutex
	cmd         *exec.Cmd
	done        chan struct{}
	fingerprint string
	launchedAt  time.Time
	lastErr     error
	endpoint    string
	nonce       string
	lifetimeW   *os.File
	testOwned   bool
}

// State 是状态查询需要的宿主进程事实（不含 nonce 或其它凭据）。
type State struct {
	Running     bool
	Fingerprint string
	LaunchedAt  time.Time
	LastError   error
	Endpoint    string
}

func (s *supervisor) state() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return State{
		Running:     s.isRunningLocked(),
		Fingerprint: s.fingerprint,
		LaunchedAt:  s.launchedAt,
		LastError:   s.lastErr,
		Endpoint:    s.endpoint,
	}
}

func (s *supervisor) isRunningLocked() bool {
	if s.testOwned && s.endpoint != "" && s.nonce != "" {
		return true
	}
	if s.cmd == nil || s.cmd.Process == nil {
		return false
	}
	select {
	case <-s.done:
		return false
	default:
		return true
	}
}

func (s *supervisor) running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.isRunningLocked()
}

func (s *supervisor) pid() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil || s.cmd.Process == nil {
		return 0
	}
	return s.cmd.Process.Pid
}

func (s *supervisor) identity() (endpoint, nonce string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.isRunningLocked() {
		return "", ""
	}
	return s.endpoint, s.nonce
}

func commandParts(config HostConfig) ([]string, error) {
	parts := strings.Fields(config.HostCommand)
	// Packaged paths (including Program Files) are executable names, never shell text.
	if config.HostArgs != nil {
		parts = append([]string{config.HostCommand}, config.HostArgs...)
	} else if info, err := os.Stat(config.HostCommand); err == nil && !info.IsDir() {
		parts = []string{config.HostCommand}
	}
	if len(parts) == 0 {
		return nil, invalidArg("empty_host_command", "未配置宿主启动命令")
	}
	return parts, nil
}

func (s *supervisor) startOwned(config HostConfig, fingerprint string, timeout time.Duration, envFor func(port int, nonce, listenFD string) []string, token string) error {
	s.mu.Lock()
	if s.isRunningLocked() && !s.testOwned {
		s.mu.Unlock()
		return nil
	}
	if s.testOwned {
		s.clearIdentityLocked()
	}
	s.mu.Unlock()

	nonce, err := randomNonce()
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	baseURL := "http://127.0.0.1:" + strconv.Itoa(port)

	var listenFile *os.File
	listenFD := ""
	if inheritedListenFD != "" {
		tcp, ok := listener.(*net.TCPListener)
		if !ok {
			_ = listener.Close()
			return errors.New("宿主监听套接字类型无效")
		}
		listenFile, err = tcp.File()
		if err != nil {
			_ = listener.Close()
			return err
		}
		listenFD = inheritedListenFD
	} else {
		_ = listener.Close()
		listener = nil
	}

	lifetimeR, lifetimeW, err := os.Pipe()
	if err != nil {
		if listenFile != nil {
			_ = listenFile.Close()
		}
		if listener != nil {
			_ = listener.Close()
		}
		return err
	}

	parts, err := commandParts(config)
	if err != nil {
		_ = lifetimeR.Close()
		_ = lifetimeW.Close()
		if listenFile != nil {
			_ = listenFile.Close()
		}
		if listener != nil {
			_ = listener.Close()
		}
		return err
	}

	cmd := exec.Command(parts[0], parts[1:]...)
	configureHostProcess(cmd)
	cmd.Env = envFor(port, nonce, listenFD)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.Stdin = lifetimeR
	cmd.ExtraFiles = extraListenFiles(listenFile)

	s.mu.Lock()
	if s.isRunningLocked() && !s.testOwned {
		s.mu.Unlock()
		_ = lifetimeR.Close()
		_ = lifetimeW.Close()
		if listenFile != nil {
			_ = listenFile.Close()
		}
		if listener != nil {
			_ = listener.Close()
		}
		return nil
	}
	if err := cmd.Start(); err != nil {
		s.lastErr = err
		s.mu.Unlock()
		_ = lifetimeR.Close()
		_ = lifetimeW.Close()
		if listenFile != nil {
			_ = listenFile.Close()
		}
		if listener != nil {
			_ = listener.Close()
		}
		return err
	}
	_ = lifetimeR.Close()
	if listenFile != nil {
		_ = listenFile.Close()
	}
	if listener != nil {
		_ = listener.Close()
	}
	s.cmd = cmd
	s.done = make(chan struct{})
	s.fingerprint = fingerprint
	s.launchedAt = time.Now()
	s.lastErr = nil
	s.nonce = nonce
	s.endpoint = ""
	s.lifetimeW = lifetimeW
	s.testOwned = false
	done := s.done
	ownedCmd := cmd
	go func() {
		_ = ownedCmd.Wait()
		s.mu.Lock()
		if s.cmd == ownedCmd {
			s.clearIdentityLocked()
			s.cmd = nil
			s.done = nil
		}
		s.mu.Unlock()
		close(done)
	}()
	s.mu.Unlock()

	if timeout <= 0 {
		timeout = defaultReadyTimeout
	}
	if err := waitChildReady(baseURL, nonce, token, timeout, done); err != nil {
		s.mu.Lock()
		s.lastErr = err
		s.mu.Unlock()
		_ = s.stop()
		return err
	}
	s.mu.Lock()
	if s.cmd == ownedCmd {
		s.endpoint = baseURL
		s.lastErr = nil
	}
	s.mu.Unlock()
	return nil
}

func waitChildReady(baseURL, nonce, token string, timeout time.Duration, done <-chan struct{}) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-done:
			return errors.New("宿主进程在就绪前退出")
		default:
		}
		ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
		health := probeOwned(ctx, baseURL, nonce, token)
		cancel()
		if health.OK && health.Instance == InstanceProof(nonce) {
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case <-done:
		return errors.New("宿主进程在就绪前退出")
	default:
		return errors.New("宿主未在时限内就绪")
	}
}

func (s *supervisor) stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopLocked()
}

func (s *supervisor) stopLocked() error {
	if s.testOwned {
		s.clearIdentityLocked()
		return nil
	}
	cmd := s.cmd
	if cmd == nil || cmd.Process == nil {
		s.clearIdentityLocked()
		return nil
	}
	if s.lifetimeW != nil {
		_ = s.lifetimeW.Close()
		s.lifetimeW = nil
	}
	if runtime.GOOS == "windows" {
		_ = cmd.Process.Kill()
	} else {
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}
	done := s.done
	s.mu.Unlock()
	var waitErr error
	if done != nil {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				waitErr = errors.New("宿主进程未在超时内退出")
			}
		}
	}
	s.mu.Lock()
	if s.cmd == cmd {
		s.cmd = nil
		s.done = nil
		s.clearIdentityLocked()
	}
	return waitErr
}

func (s *supervisor) clearIdentityLocked() {
	s.endpoint = ""
	s.nonce = ""
	s.testOwned = false
	if s.lifetimeW != nil {
		_ = s.lifetimeW.Close()
		s.lifetimeW = nil
	}
}

func (s *supervisor) testingUseEndpoint(baseURL, nonce, fingerprint string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.testOwned = true
	s.endpoint = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	s.nonce = nonce
	s.fingerprint = fingerprint
	s.launchedAt = time.Now()
	s.lastErr = nil
	s.cmd = nil
	s.done = nil
}
