package runtimeinfo

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// LockWorkspace protects opening, migrating and cleaning the same workspace.
// Legacy descriptors are used only to refuse an operation, never to discover
// an address. A live AppData shadow can therefore block an unsafe operation
// without redirecting the CLI to a different workspace.
func LockWorkspace(dataDir string) (*os.File, error) {
	lock, err := lockWorkspaceFile(dataDir)
	if err != nil {
		return nil, err
	}
	busy := false
	if info, found := Discover(dataDir); found && info.PID != os.Getpid() {
		busy = true
	}
	if raw, err := os.ReadFile(filepath.Join(dataDir, FileName)); err == nil {
		var legacy Info
		if json.Unmarshal(raw, &legacy) == nil && legacy.PID != os.Getpid() && ProcessAlive(legacy.PID) {
			busy = true
		}
	}
	if busy {
		_ = lock.Close()
		return nil, errors.New("此数据目录正在被另一实例使用，请先关闭其他 BeefTV 窗口")
	}
	return lock, nil
}
