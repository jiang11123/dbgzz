package desktopupdate

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type Target struct {
	Platform   string
	Kind       string
	Path       string
	Executable string
	PluginDir  string
}

func LocateTarget(executable string) (Target, error) {
	platform, err := CurrentPlatform()
	if err != nil {
		return Target{}, err
	}
	if strings.TrimSpace(executable) == "" {
		return Target{}, fmt.Errorf("无法定位当前应用")
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		resolved = executable
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return Target{}, err
	}
	switch runtime.GOOS {
	case "darwin":
		return locateDarwin(platform, resolved)
	case "windows":
		return locateWindows(platform, resolved)
	case "linux":
		return locateLinux(platform, resolved)
	default:
		return Target{}, ErrUnsupported
	}
}

func locateLinux(platform, executable string) (Target, error) {
	bundle := filepath.Dir(executable)
	if filepath.Base(executable) != "BeefTV" || filepath.Base(bundle) != linuxBundleName {
		return Target{}, fmt.Errorf("当前运行方式不支持自动安装更新")
	}
	if err := requireRegularFile(executable, true); err != nil {
		return Target{}, err
	}
	return Target{Platform: platform, Kind: "bundle", Path: bundle, Executable: executable, PluginDir: filepath.Join(bundle, pluginDirName)}, nil
}

func locateDarwin(platform, executable string) (Target, error) {
	macosDir := filepath.Dir(executable)
	contentsDir := filepath.Dir(macosDir)
	bundle := filepath.Dir(contentsDir)
	if !strings.EqualFold(filepath.Base(macosDir), "MacOS") || !strings.EqualFold(filepath.Base(contentsDir), "Contents") || !strings.HasSuffix(bundle, ".app") {
		return Target{}, fmt.Errorf("当前运行方式不支持自动安装更新")
	}
	if filepath.Base(bundle) != appBundleName {
		return Target{}, fmt.Errorf("当前应用包名称不支持自动更新")
	}
	if err := requireRegularFile(executable, true); err != nil {
		return Target{}, err
	}
	return Target{
		Platform:   platform,
		Kind:       "app",
		Path:       bundle,
		Executable: executable,
		PluginDir:  filepath.Join(contentsDir, "Resources", pluginDirName),
	}, nil
}

func locateWindows(platform, executable string) (Target, error) {
	if !strings.EqualFold(filepath.Base(executable), windowsExeName) {
		return Target{}, fmt.Errorf("当前运行方式不支持自动安装更新")
	}
	info, err := os.Lstat(executable)
	if err != nil || !info.Mode().IsRegular() {
		return Target{}, fmt.Errorf("无法定位当前应用")
	}
	dir := filepath.Dir(executable)
	return Target{
		Platform:   platform,
		Kind:       "exe",
		Path:       executable,
		Executable: executable,
		PluginDir:  filepath.Join(dir, pluginDirName),
	}, nil
}
