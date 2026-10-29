package assistantruntime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const hostConfigFile = "agent_config.json"

// HostConfig 记录当前使用的文本模型与宿主启动命令；由本机用户在设置里配置。
type HostConfig struct {
	Model       string   `json:"model"`
	HostCommand string   `json:"hostCommand"`
	HostArgs    []string `json:"hostArgs,omitempty"`
	UpdatedAt   string   `json:"updatedAt,omitempty"`
}

func (h *Host) EffectiveConfig() (HostConfig, bool) {
	config, configured := readHostConfig(h.dataDir())
	if strings.TrimSpace(config.HostCommand) == "" {
		if bundled := BundledConfig(h.executablePath(), h.goos()); bundled.HostCommand != "" {
			config.HostCommand = bundled.HostCommand
			config.HostArgs = bundled.HostArgs
			configured = true
		}
	}
	return config, configured
}

func (h *Host) WriteConfig(config HostConfig) error {
	return writeHostConfig(h.dataDir(), config)
}

func readHostConfig(dataDir string) (HostConfig, bool) {
	raw, err := os.ReadFile(filepath.Join(dataDir, hostConfigFile))
	if err != nil {
		return HostConfig{}, false
	}
	var config HostConfig
	if json.Unmarshal(raw, &config) != nil {
		return HostConfig{}, false
	}
	return config, true
}

func writeHostConfig(dataDir string, config HostConfig) error {
	encoded, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dataDir, ".agent-config-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(encoded); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(dataDir, hostConfigFile))
}

// BundledConfig 从可执行文件布局解析随包 Node 运行时。
// 桌面两种布局都直接执行 Node；Windows 不能依赖 POSIX shell。
func BundledConfig(executable, goos string) HostConfig {
	if strings.TrimSpace(executable) == "" {
		return HostConfig{}
	}
	root := filepath.Join(filepath.Dir(executable), "..", "Resources", "agent-host")
	node := filepath.Join(root, "runtime", "bin", "node")
	if goos == "linux" {
		root = filepath.Join(filepath.Dir(executable), "agent-host")
		node = filepath.Join(root, "runtime", "bin", "node")
	}
	if goos == "windows" {
		root = filepath.Join(filepath.Dir(executable), "agent-host")
		node = filepath.Join(root, "runtime", "node.exe")
	}
	entry := filepath.Join(root, "server.mjs")
	for _, file := range []string{node, entry} {
		if info, err := os.Stat(file); err != nil || info.IsDir() {
			return HostConfig{}
		}
	}
	return HostConfig{HostCommand: node, HostArgs: []string{entry}}
}
