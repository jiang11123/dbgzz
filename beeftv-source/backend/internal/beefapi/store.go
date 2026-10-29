package beefapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

func loadState(dataDir string) (persistedState, error) {
	body, err := os.ReadFile(filepath.Join(dataDir, connectionStoreFile))
	if errors.Is(err, os.ErrNotExist) {
		return persistedState{SchemaVersion: connectionSchema, Status: StateDisconnected, Balance: BalanceUnknown}, nil
	}
	if err != nil {
		return persistedState{}, fmt.Errorf("读取企业连接状态失败：%w", err)
	}
	var state persistedState
	if err := json.Unmarshal(body, &state); err != nil {
		return persistedState{}, fmt.Errorf("企业连接状态损坏")
	}
	if state.SchemaVersion != connectionSchema {
		return persistedState{}, fmt.Errorf("不支持的企业连接状态版本")
	}
	if state.Status == "" {
		state.Status = StateDisconnected
	}
	if state.Balance == "" {
		state.Balance = BalanceUnknown
	}
	return state, nil
}

func saveState(dataDir string, state persistedState) error {
	state.SchemaVersion = connectionSchema
	state.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	body, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("编码企业连接状态失败：%w", err)
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("创建企业连接目录失败：%w", err)
	}
	tmp, err := os.CreateTemp(dataDir, ".beefapi-connection-*")
	if err != nil {
		return fmt.Errorf("创建企业连接临时文件失败：%w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("设置企业连接权限失败：%w", err)
	}
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("写入企业连接状态失败：%w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("同步企业连接状态失败：%w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭企业连接状态失败：%w", err)
	}
	if err := os.Rename(tmpName, filepath.Join(dataDir, connectionStoreFile)); err != nil {
		return fmt.Errorf("替换企业连接状态失败：%w", err)
	}
	if directory, err := os.Open(dataDir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func clearState(dataDir string) error {
	return saveState(dataDir, persistedState{Status: StateDisconnected, Balance: BalanceUnknown})
}
