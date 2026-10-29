package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/bootstrap"
	"infinite-canvas/backend/internal/desktopstorage"
	"infinite-canvas/backend/internal/model"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type DesktopRuntimeConfig struct {
	BaseURL          string `json:"baseURL"`
	LaunchToken      string `json:"launchToken"`
	UIBootstrapToken string `json:"uiBootstrapToken"`
}

type DesktopApp struct {
	mu                      sync.RWMutex
	migrationMu             sync.Mutex
	migrating               bool
	migrationCancel         context.CancelFunc
	migrationProgress       desktopstorage.Progress
	referenceUploadProgress model.TaskReferenceProgress
	closing                 bool
	storageRoot             string
	dataDir                 string
	wailsCtx                context.Context
	pendingSkillLink        string
	chooseSavePath          func(ctx context.Context, fileName string) (string, error)
	copyOwnedMedia          func(resourceID, destPath string) error
}

// Wails reflects every field type reachable from a bound object. Keeping the
// backend Runtime inside DesktopApp caused reflection to retain the legacy
// Service's entire exported compatibility surface. The registry keeps that runtime
// private to the host process while the bound object exposes only its tiny API.
var (
	desktopRuntimeRegistryMu sync.RWMutex
	desktopRuntimeRegistry   = make(map[*DesktopApp]*bootstrap.Runtime)
)

func (a *DesktopApp) runtime() *bootstrap.Runtime {
	desktopRuntimeRegistryMu.RLock()
	defer desktopRuntimeRegistryMu.RUnlock()
	return desktopRuntimeRegistry[a]
}

type desktopAssetHandler struct {
	app *DesktopApp
}

func newDesktopApp(dataDir string) *DesktopApp {
	return &DesktopApp{dataDir: dataDir}
}

func (a *DesktopApp) start(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.migrating || a.closing {
		return errors.New("本地工作区正在关闭或迁移，请稍后重试")
	}
	if a.runtime() != nil {
		return nil
	}
	runtime, err := openDesktopRuntime(ctx, a.dataDir)
	if err != nil {
		return err
	}
	desktopRuntimeRegistryMu.Lock()
	desktopRuntimeRegistry[a] = runtime
	desktopRuntimeRegistryMu.Unlock()
	return nil
}

func openDesktopRuntime(ctx context.Context, dataDir string) (*bootstrap.Runtime, error) {
	listenAddr := strings.TrimSpace(os.Getenv("CANVAS_DESKTOP_BACKEND_ADDR"))
	if listenAddr == "" {
		listenAddr = "127.0.0.1:0"
	}
	runtime, err := bootstrap.Open(ctx, bootstrap.Config{
		Profile:         bootstrap.ProfileDesktop,
		DataDir:         dataDir,
		DatabaseDriver:  "sqlite",
		ListenAddr:      listenAddr,
		LaunchToken:     strings.TrimSpace(os.Getenv("CANVAS_DESKTOP_LAUNCH_TOKEN")),
		AutoMigrate:     true,
		ShutdownTimeout: 10 * time.Minute,
	})
	if err != nil {
		return nil, err
	}
	if err := runtime.Start(); err != nil {
		_ = runtime.Close(context.Background())
		return nil, err
	}
	return runtime, nil
}

func (a *DesktopApp) stop(ctx context.Context) error {
	a.mu.Lock()
	runtime := a.runtime()
	if runtime == nil {
		a.clearUpdater()
		a.mu.Unlock()
		return nil
	}
	desktopRuntimeRegistryMu.Lock()
	delete(desktopRuntimeRegistry, a)
	desktopRuntimeRegistryMu.Unlock()
	a.clearUpdater()
	a.mu.Unlock()
	return runtime.Close(ctx)
}

func (a *DesktopApp) RuntimeConfig() DesktopRuntimeConfig {
	a.mu.RLock()
	defer a.mu.RUnlock()
	runtime := a.runtime()
	if runtime == nil {
		return DesktopRuntimeConfig{}
	}
	return DesktopRuntimeConfig{BaseURL: runtime.BaseURL(), LaunchToken: runtime.LaunchToken(), UIBootstrapToken: runtime.UIBootstrapToken()}
}

func (a *DesktopApp) OpenBeefTVGitHub() error {
	ctx, err := a.dialogContext()
	if err != nil {
		return err
	}
	wailsruntime.BrowserOpenURL(ctx, "https://github.com/glanderness/BeefTV")
	return nil
}

func (a *DesktopApp) OpenBeefTVWebsite() error {
	ctx, err := a.dialogContext()
	if err != nil {
		return err
	}
	wailsruntime.BrowserOpenURL(ctx, "https://beeftv.app/")
	return nil
}

func (a *DesktopApp) OpenBeefTVX() error {
	ctx, err := a.dialogContext()
	if err != nil {
		return err
	}
	wailsruntime.BrowserOpenURL(ctx, "https://x.com/beefnoode")
	return nil
}

func (a *DesktopApp) SaveOwnedMedia(fileName string, resourceID string) (bool, error) {
	return a.saveToChosenPath(fileName, func(path string) error {
		return a.copyMedia(resourceID, path)
	})
}

func (a *DesktopApp) SaveOwnedArtifact(fileName string, data []byte) (bool, error) {
	return a.saveToChosenPath(fileName, func(path string) error {
		return bootstrap.WriteOwnedArtifact(path, data)
	})
}

func (a *DesktopApp) SaveOwnedArchive(fileName string, entries []bootstrap.OwnedArchiveEntry) (bool, error) {
	return a.saveToChosenPath(fileName, func(path string) error {
		runtime := a.runtime()
		if runtime == nil {
			return errors.New("本地后端尚未就绪")
		}
		ctx, err := a.dialogContext()
		if err != nil {
			return err
		}
		return runtime.WriteOwnedArchiveTo(ctx, entries, path)
	})
}

func (a *DesktopApp) saveToChosenPath(fileName string, write func(path string) error) (bool, error) {
	ctx, err := a.dialogContext()
	if err != nil {
		return false, err
	}
	path, err := a.promptSavePath(ctx, bootstrap.SanitizeSaveFileName(fileName))
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(path) == "" {
		return false, nil
	}
	if err := ctx.Err(); err != nil {
		return false, errors.New("应用已关闭，无法保存文件")
	}
	if err := write(path); err != nil {
		return false, err
	}
	return true, nil
}

func (a *DesktopApp) dialogContext() (context.Context, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.wailsCtx == nil {
		return nil, errors.New("应用尚未就绪，无法保存文件")
	}
	if err := a.wailsCtx.Err(); err != nil {
		return nil, errors.New("应用已关闭，无法保存文件")
	}
	return a.wailsCtx, nil
}

func (a *DesktopApp) promptSavePath(ctx context.Context, fileName string) (string, error) {
	a.mu.RLock()
	choose := a.chooseSavePath
	a.mu.RUnlock()
	if choose != nil {
		return choose(ctx, fileName)
	}
	return wailsruntime.SaveFileDialog(ctx, mediaSaveDialogOptions(fileName, runtime.GOOS))
}

func mediaSaveDialogOptions(fileName, platform string) wailsruntime.SaveDialogOptions {
	options := wailsruntime.SaveDialogOptions{
		DefaultFilename: fileName,
		Title:           "保存文件",
	}
	// Native save panels use this filter to preserve the format when a user
	// renames a file. Let the panel resolve the extension before overwrite checks.
	if ext := filepath.Ext(fileName); (platform == "windows" || platform == "darwin") && len(ext) > 1 {
		options.Filters = []wailsruntime.FileFilter{{
			DisplayName: strings.ToUpper(ext[1:]) + " 文件 (*" + ext + ")",
			Pattern:     "*" + ext,
		}}
	}
	return options
}

func (a *DesktopApp) copyMedia(resourceID, destPath string) error {
	a.mu.RLock()
	copyFn := a.copyOwnedMedia
	a.mu.RUnlock()
	if copyFn != nil {
		return copyFn(resourceID, destPath)
	}
	runtime := a.runtime()
	if runtime == nil {
		return errors.New("本地后端尚未就绪")
	}
	return runtime.CopyOwnedResourceTo(resourceID, destPath)
}

func (a *DesktopApp) startup(ctx context.Context) {
	a.mu.Lock()
	a.wailsCtx = ctx
	a.mu.Unlock()
	if err := prepareDesktopApp(a); err != nil {
		log.Printf("启动本地后端失败: %v", err)
		wailsruntime.LogErrorf(ctx, "启动本地后端失败: %v", err)
		wailsruntime.Quit(ctx)
	}
}

func (a *DesktopApp) shutdown(_ context.Context) {
	a.mu.Lock()
	a.wailsCtx = nil
	a.closing = true
	if a.migrationCancel != nil {
		a.migrationCancel()
	}
	a.mu.Unlock()
	a.migrationMu.Lock()
	defer a.migrationMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := a.stop(ctx); err != nil {
		log.Printf("关闭本地后端失败: %v", err)
	}
}

// ServeHTTP is only attached to Wails' in-process AssetServer. It gives the
// WebView a binding-independent bootstrap path without exposing the token on
// the loopback HTTP listener. Keeping it separate from DesktopApp prevents
// Wails from trying to expose net/http internals as frontend bindings.
func (h desktopAssetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Canvas snapshots created before the desktop API prefix was introduced may
	// still point media elements at `/resources/...`. Keep those snapshots
	// playable by routing the legacy path through the authenticated local API.
	if strings.HasPrefix(r.URL.Path, "/resources/") {
		request := r.Clone(r.Context())
		request.URL.Path = "/api" + r.URL.Path
		r = request
	}
	if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
		if err := h.app.start(r.Context()); err != nil {
			http.Error(w, "desktop backend failed to start: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		h.app.mu.RLock()
		runtime := h.app.runtime()
		h.app.mu.RUnlock()
		request := r.Clone(r.Context())
		request.Header.Set("X-Desktop-Token", runtime.LaunchToken())
		runtime.Handler().ServeHTTP(w, request)
		return
	}
	if r.Method != http.MethodGet || r.URL.Path != "/__desktop/runtime-config" {
		http.NotFound(w, r)
		return
	}
	if err := h.app.start(r.Context()); err != nil {
		http.Error(w, "desktop backend failed to start: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(h.app.RuntimeConfig())
}
