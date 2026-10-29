// Package runtimeinfo 描述「正在运行的本机工作区」这一事实：地址、进程、版本。
//
// 桌面后端监听的是动态端口，外部客户端没法猜。桌面运行时在开始监听后把地址写进
// 描述文件（0600），干净退出时删掉；CLI 在没有显式 BEEFTV_BASE_URL 时读它。
// Windows 使用用户目录下、AppData 之外的唯一位置，避免 MSIX 的 AppData 影子文件。
// 其他平台保留数据目录里的 runtime.json。已退出进程的描述文件视为过期。
//
// 桌面后端与 CLI 共用路径与存储定位，不依赖数据库或服务层。
package runtimeinfo

import (
	"encoding/json"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/desktopstorage"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// FileName 是非 Windows 平台数据目录里的描述文件名。
const FileName = "runtime.json"

// Info 是运行时描述文件的内容。
type Info struct {
	BaseURL     string    `json:"baseUrl"`
	PID         int       `json:"pid"`
	Version     string    `json:"version"`
	StartedAt   time.Time `json:"startedAt"`
	DataDirHash string    `json:"dataDirHash,omitempty"`
}

// Path 给出唯一的运行时描述文件路径。定位失败时不回退到数据目录或相对路径。
func Path(dataDir string) (string, error) {
	path, _, err := descriptorLocation(dataDir)
	return path, err
}

// Write 在后端开始监听后记录地址。只对本机用户可读（0600）。
func Write(dataDir, baseURL, version string) error {
	path, dataDirHash, err := descriptorLocation(dataDir)
	if err != nil {
		return err
	}
	payload := Info{BaseURL: baseURL, PID: os.Getpid(), Version: version, StartedAt: time.Now().UTC(), DataDirHash: dataDirHash}
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".runtime-*")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(encoded); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// Remove 在干净退出时删掉描述文件：留着会让下一次发现连到一个已经不在的端口。
// 只删本进程写的那份，避免把另一个还在跑的实例的地址抹掉。
func Remove(dataDir string) error {
	info, err := Load(dataDir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.PID != os.Getpid() {
		return nil
	}
	path, err := Path(dataDir)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Load 读出描述文件，不判断进程是否还活着。
func Load(dataDir string) (Info, error) {
	path, dataDirHash, err := descriptorLocation(dataDir)
	if err != nil {
		return Info{}, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return Info{}, err
	}
	var info Info
	if err := json.Unmarshal(raw, &info); err != nil {
		return Info{}, err
	}
	if dataDirHash != "" && info.DataDirHash != dataDirHash {
		return Info{}, errors.New("运行时描述文件不属于指定工作区")
	}
	return info, nil
}

// Discover 找出正在运行的本机工作区地址。
// dataDir 为空时按 DefaultDataDir 定位。进程已退出（过期文件）返回 false。
func Discover(dataDir string) (Info, bool) {
	if strings.TrimSpace(dataDir) == "" {
		resolved, err := DefaultDataDir()
		if err != nil {
			return Info{}, false
		}
		dataDir = resolved
	}
	info, err := Load(dataDir)
	if err != nil || strings.TrimSpace(info.BaseURL) == "" {
		return Info{}, false
	}
	if !ProcessAlive(info.PID) {
		return Info{}, false
	}
	return info, true
}

// DefaultDataDir 与桌面应用的 defaultDataDir（backend/cmd/desktop/main.go）保持同一套规则：
// CANVAS_DESKTOP_DATA_DIR 覆盖优先，否则用户配置目录下的 BeefTV
// （macOS ~/Library/Application Support/BeefTV，Windows %AppData%\BeefTV）。
// 使用与桌面相同的已选存储目录指针，不依赖桌面 main 包。
// BEEFTV_DATA_DIR 是 CLI 侧的显式指定，用来连非默认目录的工作区。
func DefaultDataDir() (string, error) {
	for _, name := range []string{"BEEFTV_DATA_DIR", "CANVAS_DESKTOP_DATA_DIR"} {
		if override := strings.TrimSpace(os.Getenv(name)); override != "" {
			return override, nil
		}
	}
	root, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("定位用户应用数据目录: %w", err)
	}
	return desktopstorage.Resolve(filepath.Join(root, "BeefTV"))
}
