package desktopupdate

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/buildinfo"
)

const (
	actionCheck    = "check"
	actionDownload = "download"
	actionInstall  = "install"
)

type verifiedUpdate struct {
	payload  Payload
	artifact PlatformArtifact
	platform string
}

type stagedUpdate struct {
	version  string
	notes    string
	archive  string
	platform string
	artifact PlatformArtifact
}

type Host struct {
	CurrentVersion string
	DataDir        string
	Quit           func() error
}

type Options struct {
	PackageManaged bool
	CurrentVersion string
	DataDir        string
	FeedURL        string
	PublicKey      string
	Platform       string
	Client         *http.Client
	StagingRoot    string
	FeedTimeout    time.Duration
	IdleTimeout    time.Duration
	RetryBackoff   func(stall int) time.Duration
	Locate         func() (Target, error)
	Helper         func(HelperRequest) error
	Quit           func() error
	ParentPID      int
}

type Engine struct {
	mu             sync.Mutex
	action         string
	state          UpdateState
	enabled        bool
	currentVersion string
	feedURL        string
	publicKey      ed25519.PublicKey
	platform       string
	client         *http.Client
	stagingRoot    string
	feedTimeout    time.Duration
	idleTimeout    time.Duration
	retryBackoff   func(stall int) time.Duration
	systemClient   bool
	meter          rateMeter
	logMu          sync.Mutex
	logPath        string
	locate         func() (Target, error)
	helper         func(HelperRequest) error
	quit           func() error
	parentPID      int
	verified       *verifiedUpdate
	staged         *stagedUpdate
	helperProc     *os.Process
	helperDone     <-chan error
	dataDir        string
}

func New(host Host) *Engine {
	opts := Options{
		CurrentVersion: host.CurrentVersion,
		DataDir:        host.DataDir,
		StagingRoot:    filepath.Join(host.DataDir, "cache", "updates"),
		Quit:           host.Quit,
		FeedURL:        FeedURL,
		PublicKey:      PublicKey,
		PackageManaged: packageManagedExecutable(),
	}
	return NewWithOptions(opts)
}

func NewWithOptions(opts Options) *Engine {
	current := stringsOr(opts.CurrentVersion, buildinfo.Current().Version)
	engine := &Engine{
		currentVersion: current,
		client:         opts.Client,
		stagingRoot:    opts.StagingRoot,
		feedTimeout:    opts.FeedTimeout,
		idleTimeout:    opts.IdleTimeout,
		retryBackoff:   opts.RetryBackoff,
		locate:         opts.Locate,
		helper:         opts.Helper,
		quit:           opts.Quit,
		parentPID:      opts.ParentPID,
		dataDir:        opts.DataDir,
		logPath:        updateLogPath(opts.DataDir),
	}
	if engine.client == nil {
		engine.client = newHTTPClient()
		engine.systemClient = true
	}
	if engine.retryBackoff == nil {
		engine.retryBackoff = defaultRetryBackoff
	}
	if engine.feedTimeout <= 0 {
		engine.feedTimeout = 30 * time.Second
	}
	if engine.idleTimeout <= 0 {
		engine.idleTimeout = 60 * time.Second
	}
	if engine.locate == nil {
		engine.locate = func() (Target, error) {
			exe, err := os.Executable()
			if err != nil {
				return Target{}, err
			}
			return LocateTarget(exe)
		}
	}
	feed := stringsOr(opts.FeedURL, FeedURL)
	key := stringsOr(opts.PublicKey, PublicKey)
	if stringsTrim(feed) == "" && stringsTrim(key) == "" {
		engine.enabled = false
	} else if stringsTrim(feed) == "" || stringsTrim(key) == "" {
		engine.enabled = false
		engine.state.Error = ErrIncompleteConfig.Error()
	} else {
		normalized, err := normalizeFeedURL(feed)
		parsedKey, keyErr := ParsePublicKey(key)
		if err != nil || keyErr != nil {
			engine.enabled = false
			engine.state.Error = "更新配置无效。"
		} else {
			engine.enabled = true
			engine.feedURL = normalized
			engine.publicKey = parsedKey
		}
	}
	if opts.Platform != "" {
		engine.platform = opts.Platform
	} else if platform, err := CurrentPlatform(); err == nil {
		engine.platform = platform
	}
	if opts.PackageManaged {
		engine.enabled = false
		engine.state.Error = "请下载新版 DEB 安装包更新。"
	}
	status := StatusIdle
	if !engine.enabled {
		status = StatusDisabled
	}
	engine.state = UpdateState{
		Status:         status,
		CurrentVersion: current,
		Error:          engine.state.Error,
	}
	return engine
}

func (e *Engine) Status() UpdateState {
	return e.snapshot()
}

func (e *Engine) CheckForUpdate(ctx context.Context) (UpdateState, error) {
	if err := e.begin(actionCheck); err != nil {
		return e.snapshot(), err
	}
	defer e.end()
	if !e.enabled {
		e.set(func(state *UpdateState) {
			state.Status = StatusDisabled
			if state.Error == "" {
				state.Error = ErrDisabled.Error()
			}
		})
		return e.snapshot(), ErrDisabled
	}
	if e.platform == "" {
		e.fail("当前系统不支持自动更新。")
		return e.snapshot(), ErrUnsupported
	}
	e.set(func(state *UpdateState) {
		state.Status = StatusChecking
		state.Error = ""
	})
	payload, err := e.fetchFeed(ctx)
	if err != nil {
		e.logf("check failed route=%s: %v", e.route(e.feedURL), rawCause(err))
		e.fail(publicError(err))
		return e.snapshot(), wrapPublic(err)
	}
	cmp, err := compareStable(e.currentVersion, payload.Version)
	if err != nil {
		e.fail("更新版本号无效。")
		return e.snapshot(), err
	}
	if cmp > 0 {
		e.fail(ErrNoDowngrade.Error())
		return e.snapshot(), ErrNoDowngrade
	}
	if cmp == 0 {
		e.mu.Lock()
		e.verified = nil
		e.mu.Unlock()
		e.set(func(state *UpdateState) {
			state.Status = StatusIdle
			state.LatestVersion = payload.Version
			state.ReleaseNotes = payload.Notes
			state.DownloadedBytes = 0
			state.TotalBytes = 0
			state.Error = ""
		})
		return e.snapshot(), nil
	}
	artifact, err := platformArtifact(payload, e.platform)
	if err != nil {
		e.fail(publicError(err))
		return e.snapshot(), wrapPublic(err)
	}
	e.mu.Lock()
	e.verified = &verifiedUpdate{payload: payload, artifact: artifact, platform: e.platform}
	e.staged = nil
	e.mu.Unlock()
	e.set(func(state *UpdateState) {
		state.Status = StatusAvailable
		state.LatestVersion = payload.Version
		state.ReleaseNotes = payload.Notes
		state.DownloadedBytes = 0
		state.TotalBytes = artifact.Size
		state.Error = ""
	})
	return e.snapshot(), nil
}

func (e *Engine) DownloadUpdate(ctx context.Context) (UpdateState, error) {
	if err := e.begin(actionDownload); err != nil {
		return e.snapshot(), err
	}
	defer e.end()
	if !e.enabled {
		return e.snapshot(), ErrDisabled
	}
	e.mu.Lock()
	verified := e.verified
	e.mu.Unlock()
	if verified == nil {
		e.fail(ErrNotAvailable.Error())
		return e.snapshot(), ErrNotAvailable
	}
	e.set(func(state *UpdateState) {
		state.InstallPrepared = false
		state.Status = StatusDownloading
		state.LatestVersion = verified.payload.Version
		state.ReleaseNotes = verified.payload.Notes
		state.DownloadedBytes = 0
		state.TotalBytes = verified.artifact.Size
		state.Error = ""
	})
	stageRoot, err := e.prepareStaging(verified.payload.Version)
	if err != nil {
		e.fail("无法准备下载目录。")
		return e.snapshot(), err
	}
	archivePath := filepath.Join(stageRoot, "update.zip")
	stagingAccepted := false
	defer func() {
		// Only remove this invocation's incomplete download, never recovery data.
		if !stagingAccepted {
			_ = os.RemoveAll(stageRoot)
		}
	}()
	if err := e.downloadArchive(ctx, verified.artifact, archivePath); err != nil {
		// The staging directory is still empty here; resumable bytes live in
		// the shared downloads directory.
		_ = os.RemoveAll(stageRoot)
		e.logf("download failed: %v", rawCause(err))
		e.fail(publicError(err))
		return e.snapshot(), wrapPublic(err)
	}
	// Keep the signed archive only. Extract once on the installation volume,
	// and validate the entire layout before the running application can exit.
	e.mu.Lock()
	e.staged = &stagedUpdate{
		version:  verified.payload.Version,
		notes:    verified.payload.Notes,
		archive:  archivePath,
		platform: verified.platform,
		artifact: verified.artifact,
	}
	e.mu.Unlock()
	stagingAccepted = true
	e.set(func(state *UpdateState) {
		state.Status = StatusReady
		state.LatestVersion = verified.payload.Version
		state.ReleaseNotes = verified.payload.Notes
		state.DownloadedBytes = verified.artifact.Size
		state.TotalBytes = verified.artifact.Size
		state.Reconnecting = false
		state.Error = ""
	})
	return e.snapshot(), nil
}

func (e *Engine) InstallUpdate(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	if err := e.begin(actionInstall); err != nil {
		return err
	}
	defer e.end()
	if !e.enabled {
		return ErrDisabled
	}
	e.mu.Lock()
	staged := e.staged
	e.mu.Unlock()
	if staged == nil {
		e.fail(ErrNotReady.Error())
		return ErrNotReady
	}
	e.set(func(state *UpdateState) {
		state.InstallPrepared = false
		state.Status = StatusInstalling
		state.Error = ""
	})
	if err := e.prepareAndStartHelper(ctx, staged); err != nil {
		state := e.snapshot()
		e.logf("install failure phase=%s completedFiles=%d totalFiles=%d timeout=%t", state.Phase, state.CompletedFiles, state.TotalFiles, errors.Is(err, ErrPreparationTimeout))
		e.logf("install preparation failed: %v", err)
		message := publicInstallError(err)
		if errors.Is(err, ErrPreparationTimeout) {
			message = preparationTimeoutMessage(state.Phase)
		}
		e.fail(message)
		return fmt.Errorf("%s", message)
	}
	e.set(func(state *UpdateState) { state.InstallPrepared = true })
	e.setPhase("restarting")
	e.logf("install prepared version=%s; requesting exit", staged.version)
	if e.quit != nil {
		if err := e.quit(); err != nil {
			e.killHelper()
			e.logf("install quit failed: %v", err)
			e.set(func(state *UpdateState) { state.InstallPrepared = false })
			e.fail("应用无法退出，已取消安装。")
			return err
		}
	}
	e.monitorHelper()
	return nil
}

func (e *Engine) killHelper() {
	e.mu.Lock()
	proc := e.helperProc
	done := e.helperDone
	e.helperProc = nil
	e.helperDone = nil
	e.mu.Unlock()
	if proc != nil {
		_ = proc.Kill()
		if done != nil {
			<-done
		}
	}
}

func (e *Engine) monitorHelper() {
	e.mu.Lock()
	done := e.helperDone
	e.mu.Unlock()
	if done != nil {
		go func() {
			helperErr := <-done
			e.logf("install helper stopped: %v", helperErr)
			// Normally this UI process has exited before the helper completes.
			// If still alive, quit was vetoed or the helper failed: permit retry.
			e.mu.Lock()
			defer e.mu.Unlock()
			if e.helperDone == done {
				e.helperProc = nil
				e.helperDone = nil
				if e.state.Status == StatusInstalling {
					e.state.Status = StatusError
					e.state.InstallPrepared = false
					e.state.Error = "应用未能退出或安装程序已停止，请重试更新。"
				}
			}
		}()
	}
}

func (e *Engine) begin(action string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.action != "" || e.state.Status == StatusInstalling {
		return ErrBusy
	}
	e.action = action
	return nil
}

func (e *Engine) end() {
	e.mu.Lock()
	e.action = ""
	e.mu.Unlock()
}

func (e *Engine) snapshot() UpdateState {
	e.mu.Lock()
	defer e.mu.Unlock()
	state := e.state.clone()
	if state.Status == StatusDownloading {
		state.BytesPerSecond = e.meter.current(time.Now())
	}
	return state
}

func (e *Engine) set(fn func(*UpdateState)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	previous := e.state.Status
	fn(&e.state)
	if previous != e.state.Status && e.state.Status != StatusError {
		e.state.Phase = ""
		e.state.CompletedFiles = 0
		e.state.TotalFiles = 0
	}
	e.state.CurrentVersion = e.currentVersion
}

func (e *Engine) setPhase(phase string) {
	e.set(func(state *UpdateState) {
		state.Phase = phase
		state.CompletedFiles = 0
		state.TotalFiles = 0
	})
	e.logf("update phase=%s", phase)
}

func (e *Engine) fail(message string) {
	e.set(func(state *UpdateState) {
		state.Status = StatusError
		state.Error = message
		state.Reconnecting = false
	})
}

func (e *Engine) updatesRoot() (string, error) {
	root := e.stagingRoot
	if root == "" {
		cache, err := os.UserCacheDir()
		if err != nil {
			cache = os.TempDir()
		}
		root = filepath.Join(cache, "BeefTV", "updates")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	return root, nil
}

func (e *Engine) prepareStaging(version string) (string, error) {
	root, err := e.updatesRoot()
	if err != nil {
		return "", err
	}
	return os.MkdirTemp(root, version+"-")
}

func publicError(err error) string {
	switch {
	case err == nil:
		return ErrInstallFailed.Error()
	case isError(err, ErrTimeout):
		return ErrTimeout.Error()
	case isError(err, ErrInvalidSignature), isError(err, ErrTampered):
		return "更新文件损坏或被篡改。"
	case isError(err, ErrWrongPlatform):
		return ErrWrongPlatform.Error()
	case isError(err, ErrInvalidArchive):
		return ErrInvalidArchive.Error()
	case isError(err, ErrNoDowngrade):
		return ErrNoDowngrade.Error()
	case isError(err, ErrNotAvailable):
		return ErrNotAvailable.Error()
	case isError(err, ErrNotReady):
		return ErrNotReady.Error()
	case isError(err, ErrUnsupported):
		return ErrUnsupported.Error()
	case isError(err, ErrDisabled):
		return ErrDisabled.Error()
	case networkSentinel(err) != nil:
		return networkSentinel(err).Error()
	default:
		if err != nil {
			msg := err.Error()
			if msg != "" && !strings.Contains(msg, "/") && !strings.Contains(msg, `\`) && !strings.Contains(strings.ToLower(msg), "tls") {
				return msg
			}
		}
		return "无法完成更新，请稍后重试。"
	}
}

func wrapPublic(err error) error {
	switch {
	case err == nil:
		return nil
	case isError(err, ErrTimeout):
		return ErrTimeout
	case isError(err, ErrInvalidSignature):
		return ErrInvalidSignature
	case isError(err, ErrTampered):
		return ErrTampered
	case isError(err, ErrWrongPlatform):
		return ErrWrongPlatform
	case isError(err, ErrInvalidArchive):
		return ErrInvalidArchive
	case isError(err, ErrNoDowngrade):
		return ErrNoDowngrade
	case isError(err, ErrNotAvailable):
		return ErrNotAvailable
	case isError(err, ErrNotReady):
		return ErrNotReady
	case isError(err, ErrUnsupported):
		return ErrUnsupported
	case networkSentinel(err) != nil:
		return networkSentinel(err)
	default:
		return fmt.Errorf("%s", publicError(err))
	}
}

func isError(err, target error) bool {
	return errors.Is(err, target)
}

func stringsOr(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return strings.TrimSpace(fallback)
}

func stringsTrim(value string) string {
	return strings.TrimSpace(value)
}
