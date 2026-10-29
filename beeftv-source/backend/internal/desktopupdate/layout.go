package desktopupdate

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func validateExtractedLayout(root, platform string) error {
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	switch platform {
	case "darwin-arm64", "darwin-amd64":
		return validateDarwinLayout(root)
	case "windows-amd64":
		return validateWindowsLayout(root)
	case "linux-amd64":
		return validateLinuxLayout(root)
	default:
		return ErrUnsupported
	}
}

func validateLinuxLayout(root string) error {
	bundle := filepath.Join(root, linuxBundleName)
	if err := requireRegularFile(filepath.Join(bundle, "BeefTV"), true); err != nil {
		return err
	}
	if err := requireRegularFile(filepath.Join(bundle, cliDirName, darwinCLIName), true); err != nil {
		return err
	}
	if err := validateAgentHost(filepath.Join(bundle, "agent-host"), "runtime/bin/node", true); err != nil {
		return err
	}
	plugins, err := os.ReadDir(filepath.Join(bundle, pluginDirName))
	if err != nil {
		return err
	}
	found := false
	for _, plugin := range plugins {
		if !plugin.IsDir() && strings.HasSuffix(plugin.Name(), pluginExtension) {
			if err := requireRegularFile(filepath.Join(bundle, pluginDirName, plugin.Name()), false); err != nil {
				return err
			}
			found = true
		}
	}
	if !found {
		return fmt.Errorf("更新包缺少官方插件")
	}
	return walkAllowed(root, func(rel string, entry fs.DirEntry) error {
		if rel == "." || rel == linuxBundleName || rel == filepath.Join(linuxBundleName, "BeefTV") || rel == filepath.Join(linuxBundleName, "README.md") {
			return nil
		}
		for _, name := range []string{pluginDirName, "agent-host", cliDirName} {
			prefix := filepath.Join(linuxBundleName, name)
			if rel == prefix || strings.HasPrefix(rel, prefix+string(filepath.Separator)) {
				return nil
			}
		}
		return fmt.Errorf("更新包包含额外文件")
	})
}

func validateDarwinLayout(root string) error {
	bundle := filepath.Join(root, appBundleName)
	info, err := os.Lstat(bundle)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("更新包缺少 BeefTV.app")
	}
	exe := filepath.Join(bundle, "Contents", "MacOS", "BeefTV")
	if err := requireRegularFile(exe, true); err != nil {
		return err
	}
	// 随包 CLI 在主程序旁的 cli 目录里：外部 Agent 靠它接入，缺了就不是完整的安装版。
	if err := requireRegularFile(filepath.Join(bundle, "Contents", "MacOS", cliDirName, darwinCLIName), true); err != nil {
		return fmt.Errorf("更新包缺少随包 beeftv CLI: %w", err)
	}
	if err := validateAgentHost(filepath.Join(bundle, "Contents", "Resources", "agent-host"), "runtime/bin/node", true); err != nil {
		return err
	}
	media := filepath.Join(bundle, "Contents", "Resources", "agent-host", "media-runtime")
	if _, err := os.Lstat(media); err == nil {
		for _, name := range []string{"ffprobe", "LICENSE", "README.txt", "manifest.json"} {
			if err := requireRegularFile(filepath.Join(media, name), name == "ffprobe"); err != nil {
				return fmt.Errorf("更新包媒体检查工具不完整: %w", err)
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return walkAllowed(root, func(rel string, entry fs.DirEntry) error {
		if rel == "." {
			return nil
		}
		if rel == appBundleName || strings.HasPrefix(rel, appBundleName+string(filepath.Separator)) {
			return nil
		}
		return fmt.Errorf("更新包包含额外文件")
	})
}

func validateWindowsLayout(root string) error {
	if err := validateAgentHost(filepath.Join(root, "agent-host"), "runtime/node.exe", false); err != nil {
		return err
	}
	exe := filepath.Join(root, windowsExeName)
	// Nest new media in agent-host so old helpers replace it with that sidecar.
	// Accept the earlier standalone layout too, but require complete resources.
	for _, media := range []string{filepath.Join(root, "agent-host", "media-runtime"), filepath.Join(root, "media-runtime")} {
		if _, err := os.Lstat(media); err == nil {
			for _, name := range []string{"ffmpeg.exe", "ffprobe.exe", "LICENSE", "README.txt", "manifest.json"} {
				if err := requireRegularFile(filepath.Join(media, name), false); err != nil {
					return fmt.Errorf("更新包视频工具不完整: %w", err)
				}
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	if err := requireRegularFile(exe, false); err != nil {
		return fmt.Errorf("更新包缺少 BeefTV.exe")
	}
	if err := requireRegularFile(filepath.Join(root, cliDirName, windowsCLIName), false); err != nil {
		return fmt.Errorf("更新包缺少随包 beeftv CLI: %w", err)
	}
	plugins := filepath.Join(root, pluginDirName)
	info, err := os.Lstat(plugins)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("更新包缺少 plugin-packages")
	}
	entries, err := os.ReadDir(plugins)
	if err != nil {
		return err
	}
	foundPlugin := false
	for _, entry := range entries {
		if entry.IsDir() {
			return fmt.Errorf("官方插件目录布局无效")
		}
		if strings.HasSuffix(strings.ToLower(entry.Name()), pluginExtension) {
			if err := requireRegularFile(filepath.Join(plugins, entry.Name()), false); err != nil {
				return err
			}
			foundPlugin = true
		}
	}
	if !foundPlugin {
		return fmt.Errorf("更新包缺少官方插件")
	}
	return walkAllowed(root, func(rel string, entry fs.DirEntry) error {
		if rel == "." || rel == windowsExeName {
			return nil
		}
		if rel == cliDirName || strings.HasPrefix(rel, cliDirName+string(filepath.Separator)) {
			return nil
		}
		if rel == pluginDirName || strings.HasPrefix(rel, pluginDirName+string(filepath.Separator)) {
			return nil
		}
		if rel == "media-runtime" || strings.HasPrefix(rel, "media-runtime"+string(filepath.Separator)) {
			return nil
		}
		if rel == "agent-host" || strings.HasPrefix(rel, "agent-host"+string(filepath.Separator)) {
			return nil
		}
		return fmt.Errorf("更新包包含额外文件")
	})
}

func validateAgentHost(root, node string, executable bool) error {
	for _, name := range []string{"server.mjs", "session-identity.mjs", "canvas-turn.mjs", "request-budget.mjs", "package.json", "node_modules/@earendil-works/pi-coding-agent/package.json", node} {
		if err := requireRegularFile(filepath.Join(root, filepath.FromSlash(name)), name == node && executable); err != nil {
			return fmt.Errorf("更新包内置助手资源不完整: %s: %w", name, err)
		}
	}
	return nil
}

func requireRegularFile(path string, executable bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("更新包缺少可执行文件")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("更新包可执行文件无效")
	}
	if executable && info.Mode()&0o111 == 0 {
		if err := os.Chmod(path, info.Mode().Perm()|0o755); err != nil {
			return fmt.Errorf("无法设置可执行权限")
		}
	}
	return nil
}

func walkAllowed(root string, fn func(rel string, entry fs.DirEntry) error) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		return fn(rel, entry)
	})
}
