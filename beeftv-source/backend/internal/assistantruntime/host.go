// Package assistantruntime owns the built-in assistant host child process:
// config, env, start/stop, and idle restart. HTTP handlers decode and respond;
// bootstrap owns each Host lifetime. Separate Host values do not share a child.
package assistantruntime

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/assistant"
)

// Options 是 Host 的可注入边界：配置、供应商解析、凭据与进程环境。
type Options struct {
	DataDir         string
	ResolveProvider func() (assistant.Provider, string)
	HostToken       func() string
	OwnerToken      func() string
	Environ         func() []string
	BackendAddr     func() string
	Executable      func() (string, error)
	GOOS            string
	ReadyTimeout    time.Duration
}

// Host 是一个助手宿主监督器实例。bootstrap 为每个运行时持有一个；
// 路由通过 RuntimeDependencies 拿到同一实例，而不是进程级全局变量。
type Host struct {
	opts      Options
	proc      *supervisor
	lifecycle sync.Mutex
	closed    bool
}

func New(opts Options) *Host {
	return &Host{opts: opts, proc: &supervisor{}}
}

func OptionsFromService(svc ProviderService) Options {
	if svc == nil {
		return Options{ResolveProvider: func() (assistant.Provider, string) {
			return ResolveProvider(nil)
		}}
	}
	return Options{
		DataDir: svc.DataDir(),
		ResolveProvider: func() (assistant.Provider, string) {
			return ResolveProvider(svc.ResolveAssistantProvider)
		},
	}
}

func (h *Host) dataDir() string {
	if h == nil {
		return ""
	}
	return h.opts.DataDir
}

func (h *Host) goos() string {
	if h != nil && strings.TrimSpace(h.opts.GOOS) != "" {
		return h.opts.GOOS
	}
	return runtime.GOOS
}

func (h *Host) executablePath() string {
	if h != nil && h.opts.Executable != nil {
		path, err := h.opts.Executable()
		if err != nil {
			return ""
		}
		return path
	}
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	return path
}

func (h *Host) State() State {
	if h == nil {
		return State{}
	}
	return h.proc.state()
}

func (h *Host) Running() bool {
	return h != nil && h.proc.running()
}

func (h *Host) PID() int {
	if h == nil {
		return 0
	}
	return h.proc.pid()
}

// Endpoint is the supervisor-owned loopback URL. Empty until this Host has
// launched a child and health has proved the instance nonce.
func (h *Host) Endpoint() string {
	if h == nil {
		return ""
	}
	endpoint, _ := h.proc.identity()
	return endpoint
}

func (h *Host) readyTimeout() time.Duration {
	if h != nil && h.opts.ReadyTimeout > 0 {
		return h.opts.ReadyTimeout
	}
	return defaultReadyTimeout
}

// TestingUseOwnedEndpoint injects a loopback child for handler tests. Production
// never reads BEEFTV_AGENT_HOST_URL or :18500 as a fallback.
func (h *Host) TestingUseOwnedEndpoint(baseURL, nonce, fingerprint string) {
	if h == nil {
		return
	}
	h.proc.testingUseEndpoint(baseURL, nonce, fingerprint)
}

// Start 在应用启动时按本机配置拉起内置宿主。
// 未配置启动命令或模型/凭据还没解析出来时是 no-op（用户没配好助手不应该让应用启动失败）；
// 之后界面查询 /assistant/status 会按当时的配置补上这次启动。
func (h *Host) Start(opsURL, desktopToken string) error {
	if h == nil {
		return nil
	}
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()
	config, configured := h.EffectiveConfig()
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return nil
	}
	provider, reason := h.ResolveProvider()
	if reason != "" {
		return nil
	}
	return h.startOwned(config, provider, opsURL, desktopToken)
}

// Launch 按已解析的供应商启动；已在跑则是 no-op。调用方负责先检查配置是否存在。
func (h *Host) Launch(provider assistant.Provider, opsURL, desktopToken string) error {
	if h == nil {
		return invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()
	return h.launchLocked(provider, opsURL, desktopToken)
}

func (h *Host) launchLocked(provider assistant.Provider, opsURL, desktopToken string) error {
	config, configured := h.EffectiveConfig()
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	return h.startOwned(config, provider, opsURL, desktopToken)
}

func (h *Host) Stop() error {
	if h == nil {
		return nil
	}
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()
	return h.proc.stop()
}

// StopContext 在应用关闭时停止**本 Host 启动的**内置宿主子进程。
//
// 只对它自己启动过的进程生效（未启动时是 no-op），不会去清理外接宿主或别人的 PID；
// 宿主不可达/已退出时返回 nil，避免把关闭流程拖成失败。
// 超时仍等到 stop 结束才释放生命周期锁，避免 Ensure/Restart 在回收中途再拉起进程。
// 关闭后不再接受启动；用户手动停止后仍需重启的场景使用 Stop。
func (h *Host) StopContext(ctx context.Context) error {
	if h == nil {
		return nil
	}
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()
	h.closed = true
	if !h.proc.running() {
		return nil
	}
	done := make(chan error, 1)
	go func() { done <- h.proc.stop() }()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("停止内置创作助手宿主：%w", err)
		}
		return nil
	case <-ctx.Done():
		err := <-done
		if err != nil {
			return fmt.Errorf("停止内置创作助手宿主超时：%w", ctx.Err())
		}
		return fmt.Errorf("停止内置创作助手宿主超时：%w", ctx.Err())
	}
}

// Ensure 让状态查询自己把宿主带起来：
// 没跑就按当前配置启动；跑着但供应商指纹变了、而且此刻空闲，就重启到新配置。
// 返回 launched=true 表示这次调用刚拉起进程（界面此时应显示 host_starting）。
func (h *Host) Ensure(provider assistant.Provider, opsURL, desktopToken string, idle bool) (launched bool, err error) {
	if h == nil {
		return false, invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()
	config, configured := h.EffectiveConfig()
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return false, invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	state := h.proc.state()
	fingerprint := provider.Fingerprint()
	if state.Running {
		if state.Fingerprint == "" || state.Fingerprint == fingerprint || !idle {
			return false, nil
		}
		if stopErr := h.proc.stop(); stopErr != nil {
			return false, stopErr
		}
	}
	if startErr := h.startOwned(config, provider, opsURL, desktopToken); startErr != nil {
		return false, startErr
	}
	return true, nil
}

func (h *Host) startOwned(config HostConfig, provider assistant.Provider, opsURL, desktopToken string) error {
	if h.closed {
		return invalidArg("host_stopping", "应用正在退出，不能启动助手宿主")
	}
	return h.proc.startOwned(config, provider.Fingerprint(), h.readyTimeout(), func(port int, nonce, listenFD string) []string {
		return h.buildEnv(provider, childPin{
			Port:       port,
			Nonce:      nonce,
			ListenFD:   listenFD,
			Lifetime:   true,
			OpsURL:     opsURL,
			DesktopTok: desktopToken,
		})
	}, h.hostToken())
}

// Restart 是「重试」按钮的真实动作：停掉旧进程再按当前配置启动。
func (h *Host) Restart(provider assistant.Provider, opsURL, desktopToken string) error {
	if h == nil {
		return invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()
	config, configured := h.EffectiveConfig()
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	if err := h.proc.stop(); err != nil {
		return err
	}
	return h.startOwned(config, provider, opsURL, desktopToken)
}
