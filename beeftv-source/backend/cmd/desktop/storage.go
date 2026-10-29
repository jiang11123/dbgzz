package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"infinite-canvas/backend/internal/bootstrap"
	"infinite-canvas/backend/internal/desktopstorage"
	"infinite-canvas/backend/internal/runtimeinfo"
)

func (a *DesktopApp) StorageSettings() (desktopstorage.Usage, error) {
	a.mu.RLock()
	path := a.dataDir
	a.mu.RUnlock()
	usage, err := desktopstorage.Inspect(path)
	if err != nil {
		return usage, err
	}
	root := a.storageRoot
	if root == "" {
		root, err = desktopstorage.DefaultRoot()
		if err != nil {
			return usage, err
		}
	}
	location, err := desktopstorage.MigrationLocation(root, path)
	if err != nil {
		return usage, err
	}
	if location.PreviousDir != "" && len(location.PreviousFiles) > 0 {
		previous, inspectErr := desktopstorage.Inspect(location.PreviousDir)
		if inspectErr == nil {
			usage.PreviousDir = location.PreviousDir
			usage.PreviousBytes = previous.UsedBytes
		}
	}
	return usage, nil
}

func (a *DesktopApp) CleanupPreviousStorage() (desktopstorage.Usage, error) {
	if !a.migrationMu.TryLock() {
		return desktopstorage.Usage{}, errors.New("存储操作正在进行，请等待完成")
	}
	defer a.migrationMu.Unlock()
	a.mu.RLock()
	current, root := a.dataDir, a.storageRoot
	a.mu.RUnlock()
	var err error
	if root == "" {
		root, err = desktopstorage.DefaultRoot()
		if err != nil {
			return desktopstorage.Usage{}, err
		}
	}
	if a.runtime() == nil || !a.runtime().Ready() {
		return desktopstorage.Usage{}, errors.New("当前工作区尚未就绪，暂不清理原目录")
	}
	if err = desktopstorage.CleanupPrevious(root, current, runtimeinfo.LockWorkspace); err != nil {
		return desktopstorage.Usage{}, err
	}
	return a.StorageSettings()
}

func (a *DesktopApp) ChooseStorageDirectory() (string, error) {
	ctx, err := a.dialogContext()
	if err != nil {
		return "", err
	}
	path, err := wailsruntime.OpenDirectoryDialog(ctx, wailsruntime.OpenDialogOptions{Title: "选择 BeefTV 数据存储文件夹"})
	if err == nil && path != "" && filepath.Dir(path) == path {
		path = filepath.Join(path, "BeefTV")
	}
	return path, err
}

func (a *DesktopApp) MigrateStorage(target string) (desktopstorage.Usage, error) {
	if !a.migrationMu.TryLock() {
		return desktopstorage.Usage{}, errors.New("数据正在迁移，请等待完成")
	}
	defer a.migrationMu.Unlock()
	a.setMigrationProgress(desktopstorage.Progress{Phase: "preparing", Detail: "正在检查存储目录与磁盘空间"})
	if a.storageRoot == "" && strings.TrimSpace(os.Getenv("CANVAS_DESKTOP_DATA_DIR")) != "" {
		return desktopstorage.Usage{}, errors.New("请先移除 CANVAS_DESKTOP_DATA_DIR 环境变量，再在设置中迁移存储目录")
	}
	a.mu.RLock()
	source := a.dataDir
	root := a.storageRoot
	a.mu.RUnlock()
	target, err := desktopstorage.Validate(source, target)
	if err != nil {
		return desktopstorage.Usage{}, err
	}
	exe, err := os.Executable()
	if err != nil {
		return desktopstorage.Usage{}, err
	}
	overlaps, err := desktopstorage.Overlaps(filepath.Dir(exe), target)
	if err != nil {
		return desktopstorage.Usage{}, err
	}
	if overlaps {
		return desktopstorage.Usage{}, errors.New("数据目录不能使用程序安装目录")
	}
	if root == "" {
		root, err = desktopstorage.DefaultRoot()
		if err != nil {
			return desktopstorage.Usage{}, err
		}
	}
	ctx, cancelMigration := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancelMigration()
	a.mu.Lock()
	if a.closing {
		a.mu.Unlock()
		return desktopstorage.Usage{}, errors.New("应用正在关闭，迁移未开始")
	}
	a.migrating = true
	a.migrationCancel = cancelMigration
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.migrating = false; a.migrationCancel = nil; a.mu.Unlock() }()
	currentRuntime := a.runtime()
	if currentRuntime == nil {
		return desktopstorage.Usage{}, errors.New("工作区尚未就绪，迁移未开始。请重启 BeefTV 后重试")
	}
	prepareCtx, prepareCancel := context.WithTimeout(ctx, 10*time.Second)
	a.setMigrationProgress(desktopstorage.Progress{Phase: "preparing", Detail: "正在停止后台任务并保存工作区"})
	resume, prepareErr := currentRuntime.PrepareStorageMigration(prepareCtx)
	prepareCancel()
	if prepareErr != nil {
		return desktopstorage.Usage{}, prepareErr
	}
	defer resume()
	// Nothing may reopen the source while SQLite and workers are being closed.
	stopCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	err = a.stop(stopCtx)
	cancel()
	restore := func(cause error) (desktopstorage.Usage, error) {
		a.mu.RLock()
		closing := a.closing
		a.mu.RUnlock()
		if closing {
			return desktopstorage.Usage{}, cause
		}
		old, openErr := openDesktopRuntime(context.Background(), source)
		if openErr == nil {
			a.installStorageRuntime(source, old)
			return desktopstorage.Usage{}, fmt.Errorf("迁移未完成，已恢复原工作区，存储目录未更改。请查看错误详情\n\n%w", cause)
		}
		return desktopstorage.Usage{}, fmt.Errorf("迁移未完成，原数据已保留，但工作区未能重新打开。请重启 BeefTV\n\n%w", errors.Join(cause, openErr))
	}
	if err != nil {
		a.mu.Lock()
		a.closing = true
		a.mu.Unlock()
		return desktopstorage.Usage{}, fmt.Errorf("迁移未开始，原数据仍在原目录。工作区未能完整关闭，请重启 BeefTV 后重试\n\n%w", err)
	}
	sourceLock, err := runtimeinfo.LockWorkspace(source)
	if err != nil {
		return restore(err)
	}
	defer sourceLock.Close()
	// Release before rollback reopens the source runtime.
	oldRestore := restore
	restore = func(cause error) (desktopstorage.Usage, error) { _ = sourceLock.Close(); return oldRestore(cause) }
	a.setMigrationProgress(desktopstorage.Progress{Phase: "processing", Detail: "正在检查原目录文件"})
	files, err := desktopstorage.Snapshot(source)
	if err != nil {
		return restore(err)
	}
	if err := desktopstorage.CopyClosedWorkspace(ctx, source, target, a.setMigrationProgress); err != nil {
		return restore(fmt.Errorf("迁移失败，原数据已保留: %w", err))
	}
	a.mu.RLock()
	progress := a.migrationProgress
	a.mu.RUnlock()
	progress.Phase, progress.Detail = "processing", "正在核对原目录与新目录的完整性"
	a.setMigrationProgress(progress)
	if err = desktopstorage.VerifySnapshot(source, files, false); err != nil {
		return restore(err)
	}
	if err = desktopstorage.VerifySnapshot(target, files, false); err != nil {
		return restore(err)
	}
	usage, err := desktopstorage.Inspect(target)
	if err != nil {
		return restore(err)
	}
	progress.Detail = "正在打开新目录并恢复工作区"
	a.setMigrationProgress(progress)
	next, err := openDesktopRuntime(ctx, target)
	if err != nil {
		return restore(fmt.Errorf("新目录无法打开，继续使用原目录: %w", err))
	}
	if err = ctx.Err(); err != nil {
		_ = next.Close(context.Background())
		return restore(err)
	}
	if a.storageRoot == "" {
		if err = configureDesktopTemp(target); err != nil {
			_ = next.Close(context.Background())
			return restore(err)
		}
	}
	if err := desktopstorage.SaveMigration(root, target, source, files); err != nil {
		_ = next.Close(context.Background())
		if a.storageRoot == "" {
			_ = configureDesktopTemp(source)
		}
		return restore(fmt.Errorf("存储目录设置未保存，继续使用原目录: %w", err))
	}
	a.installStorageRuntime(target, next)
	progress.Phase, progress.Detail = "done", "迁移完成，正在重新载入"
	a.setMigrationProgress(progress)
	return usage, nil
}

func (a *DesktopApp) setMigrationProgress(progress desktopstorage.Progress) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.migrationProgress = progress
}

func (a *DesktopApp) StorageMigrationStatus() desktopstorage.Progress {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.migrationProgress
}

func (a *DesktopApp) installStorageRuntime(path string, runtime *bootstrap.Runtime) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.dataDir = path
	desktopRuntimeRegistryMu.Lock()
	desktopRuntimeRegistry[a] = runtime
	desktopRuntimeRegistryMu.Unlock()
}
