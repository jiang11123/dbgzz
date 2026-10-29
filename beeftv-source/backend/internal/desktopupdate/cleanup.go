package desktopupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CleanupAfterStartup is called only after the desktop backend has started and
// the rendered workspace has hydrated its assets and canvases. Merely spawning
// a replacement process must never discard its recovery copy.
func (e *Engine) CleanupAfterStartup(ctx context.Context) error {
	target, err := e.locate()
	if err != nil {
		return err
	}
	for {
		err = cleanupCompletedUpdates(target, e.dataDir)
		if err == nil {
			return nil
		}
		// The launching helper can still hold the install lock or, on Windows,
		// its executable. Leave retryable records intact until it exits.
		select {
		case <-ctx.Done():
			return fmt.Errorf("清理升级文件失败: %w", err)
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func cleanupCompletedUpdates(target Target, dataDir string) error {
	parent, err := filepath.EvalSymlinks(filepath.Dir(target.Path))
	if err != nil {
		return err
	}
	unlock, err := lockInstall(filepath.Join(parent, ".BeefTV.update.lock"))
	if err != nil {
		return err
	}
	defer unlock()
	entries, err := os.ReadDir(parent)
	if err != nil {
		return err
	}
	if dataDir != "" {
		dataDir, err = physicalPath(dataDir)
		if err != nil {
			return err
		}
	}
	var cleanupErr error
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), ".beeftv-update-") {
			continue
		}
		dir := filepath.Join(parent, entry.Name())
		if dataDir != "" && (withinRoot(dir, dataDir) || withinRoot(dataDir, dir)) {
			continue
		}
		if !completedUpdateDirectory(dir, target) {
			continue
		}
		if err := removeCompletedUpdate(dir); err != nil {
			cleanupErr = err
		}
	}
	return cleanupErr
}

func completedUpdateDirectory(dir string, target Target) bool {
	var req HelperRequest
	var result RecoveryState
	if readCleanupRecord(filepath.Join(dir, "request.json"), &req) != nil || readCleanupRecord(filepath.Join(dir, "result.json"), &result) != nil {
		return false
	}
	if req.Schema != helperRequestSchema || req.Platform != target.Platform || req.ParentPID <= 0 {
		return false
	}
	installed, err := physicalPath(req.TargetPath)
	current, currentErr := physicalPath(target.Path)
	if err != nil || currentErr != nil || installed != current {
		return false
	}
	// Do not trust persisted paths as deletion targets. Only the updater's
	// exact sibling layout may be cleaned, including records from older builds.
	for name, path := range map[string]string{"payload": req.StagedPath, "backup": req.BackupPath, "prepared": req.PreparedPath, "result.json": req.ResultPath} {
		recordedParent, err := filepath.EvalSymlinks(filepath.Dir(path))
		if err != nil || recordedParent != dir || filepath.Base(path) != name {
			return false
		}
	}
	return result.Status == "launched" && result.Phase == "done" && result.Launched && result.ParentExited && !result.Restored && result.Error == "" && result.BackupPath == req.BackupPath
}

func readCleanupRecord(path string, value any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 64*1024 {
		return fmt.Errorf("升级记录无效")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func removeCompletedUpdate(dir string) error {
	// Remove the helper first: Windows can still be executing it. Keep both
	// records until payload cleanup succeeds so the next startup can retry.
	names := []string{"BeefTV-update-helper", "BeefTV-update-helper.exe", "backup", "payload", "helper.log", "prepared", "result.json", "request.json"}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		known := false
		for _, name := range names {
			known = known || entry.Name() == name
		}
		if !known {
			return nil
		}
	}
	for _, name := range names {
		if err := os.RemoveAll(filepath.Join(dir, name)); err != nil {
			return err
		}
	}
	return os.Remove(dir)
}
