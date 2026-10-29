package main

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
)

// OpenUpdateLogDirectory accepts no caller path; it only opens this workspace.
func (a *DesktopApp) OpenUpdateLogDirectory() error {
	if _, err := a.dialogContext(); err != nil {
		return err
	}
	a.mu.RLock()
	dir := a.dataDir
	a.mu.RUnlock()
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return errors.New("数据目录无法打开，请在存储设置中检查当前目录。")
	}
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("explorer.exe", dir)
	case "darwin":
		command = exec.Command("open", dir)
	default:
		command = exec.Command("xdg-open", dir)
	}
	if err := command.Start(); err != nil {
		return errors.New("无法打开日志文件夹，请在存储设置中查看当前目录。")
	}
	go func() { _ = command.Wait() }()
	return nil
}
