package desktopupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const helperRequestSchema = 1

type HelperRequest struct {
	DataDir        string `json:"dataDir,omitempty"`
	Schema         int    `json:"schema"`
	ParentPID      int    `json:"parentPid"`
	Platform       string `json:"platform"`
	TargetPath     string `json:"targetPath"`
	StagedPath     string `json:"stagedPath"`
	BackupPath     string `json:"backupPath"`
	PreparedPath   string `json:"preparedPath"`
	ResultPath     string `json:"resultPath"`
	WaitTimeoutSec int    `json:"waitTimeoutSec"`
}

type RecoveryState struct {
	Status       string `json:"status"`
	Phase        string `json:"phase"`
	Error        string `json:"error,omitempty"`
	BackupPath   string `json:"backupPath,omitempty"`
	Restored     bool   `json:"restored"`
	Launched     bool   `json:"launched"`
	ParentExited bool   `json:"parentExited"`
}

func HandleHelperCommand(args []string) (bool, error) {
	requestPath, found := helperRequestArg(args)
	if !found {
		return false, nil
	}
	if requestPath == "" {
		return true, fmt.Errorf("缺少更新请求文件")
	}
	return true, RunHelperRequestFile(requestPath)
}

func helperRequestArg(args []string) (string, bool) {
	for i, arg := range args {
		if arg == helperFlag {
			if i+1 >= len(args) {
				return "", true
			}
			return args[i+1], true
		}
	}
	return "", false
}

func RunHelperRequestFile(requestPath string) error {
	data, err := os.ReadFile(requestPath)
	if err != nil {
		return fmt.Errorf("读取更新请求失败: %w", err)
	}
	var req HelperRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return fmt.Errorf("更新请求无效")
	}
	return RunHelperRequest(req)
}

func RunHelperRequest(req HelperRequest) error {
	result := RecoveryState{Status: "failed", Phase: "validate", BackupPath: req.BackupPath}
	writeRecovery := func() {
		if req.ResultPath == "" {
			return
		}
		_ = os.MkdirAll(filepath.Dir(req.ResultPath), 0o700)
		data, err := json.Marshal(result)
		if err != nil {
			return
		}
		_ = os.WriteFile(req.ResultPath, data, 0o600)
	}
	var releaseLock func()
	defer func() {
		if result.Error != "" && result.Status != "rolled_back" {
			result.Status = "failed"
		}
		// Startup cleanup must see the final record before it can take the lock.
		writeRecovery()
		if releaseLock != nil {
			releaseLock()
		}
	}()

	if err := validateHelperRequest(req); err != nil {
		result.Error = err.Error()
		return err
	}
	unlock, err := lockInstall(filepath.Join(filepath.Dir(req.TargetPath), ".BeefTV.update.lock"))
	if err != nil {
		result.Error = "已有更新正在安装"
		return err
	}
	releaseLock = unlock
	if req.PreparedPath != "" {
		if err := os.WriteFile(req.PreparedPath, []byte("ok\n"), 0o600); err != nil {
			result.Error = err.Error()
			return err
		}
	}
	result.Status = "prepared"
	result.Phase = "wait_parent"
	writeRecovery()

	timeout := time.Duration(req.WaitTimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	if err := waitForPID(req.ParentPID, timeout); err != nil {
		result.Error = err.Error()
		return err
	}
	result.ParentExited = true
	result.Phase = "replace"
	writeRecovery()

	if err := SwapInstall(req); err != nil {
		result.Error = err.Error()
		if restoreErr := RestoreBackup(req); restoreErr == nil && pathExists(req.TargetPath) {
			result.Restored = true
			result.Status = "rolled_back"
			result.Launched = relaunchInstall(req) == nil
		}
		return err
	}
	result.Phase = "launch"
	writeRecovery()
	if err := relaunchInstall(req); err != nil {
		result.Error = err.Error()
		if restoreErr := RestoreBackup(req); restoreErr == nil {
			result.Restored = true
			result.Status = "rolled_back"
			_ = relaunchInstall(req)
		}
		return err
	}
	result.Launched = true
	result.Status = "launched"
	result.Phase = "done"
	// Retain recovery files: process creation is not proof of healthy startup.
	return nil
}

func validateHelperRequest(req HelperRequest) error {
	if req.Schema != helperRequestSchema {
		return fmt.Errorf("更新请求版本不支持")
	}
	if req.ParentPID <= 0 {
		return fmt.Errorf("更新请求缺少进程信息")
	}
	if !filepath.IsAbs(req.TargetPath) || !filepath.IsAbs(req.StagedPath) || !filepath.IsAbs(req.BackupPath) {
		return fmt.Errorf("更新路径无效")
	}
	if err := validateExtractedLayout(req.StagedPath, req.Platform); err != nil {
		return err
	}
	switch {
	case strings.HasPrefix(req.Platform, "darwin"):
		if filepath.Base(req.TargetPath) != appBundleName {
			return fmt.Errorf("当前应用包名称不支持自动更新")
		}
	case strings.HasPrefix(req.Platform, "windows"):
		if filepath.Base(req.TargetPath) != windowsExeName {
			return fmt.Errorf("当前应用名称不支持自动更新")
		}
	case req.Platform == "linux-amd64":
		if filepath.Base(req.TargetPath) != linuxBundleName {
			return fmt.Errorf("当前应用包名称不支持自动更新")
		}
	default:
		return ErrUnsupported
	}
	return nil
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func (e *Engine) prepareAndStartHelper(ctx context.Context, staged *stagedUpdate) error {
	started := time.Now()
	defer func() { e.logf("install preparation elapsed=%s", time.Since(started).Round(time.Millisecond)) }()
	e.setPhase("verifying")
	target, err := e.locate()
	if err != nil {
		return err
	}
	if e.dataDir != "" {
		dataDir, err := physicalPath(e.dataDir)
		if err != nil {
			return err
		}
		installRoot := target.Path
		if strings.HasPrefix(target.Platform, "windows") || strings.HasPrefix(staged.platform, "windows") {
			installRoot = filepath.Dir(target.Path)
		}
		installRoot, err = physicalPath(installRoot)
		if err != nil {
			return err
		}
		if withinRoot(installRoot, dataDir) || withinRoot(dataDir, installRoot) {
			return fmt.Errorf("数据目录与程序目录重叠，请先将数据移到独立目录")
		}
	}
	parentPID := e.parentPID
	if parentPID <= 0 {
		parentPID = os.Getpid()
	}
	// Prepare on the target volume before exit, so denied access or disk-full
	// cannot leave a closed application with half-copied replacement files.
	workDir, err := os.MkdirTemp(filepath.Dir(target.Path), ".beeftv-update-*")
	if err != nil {
		return err
	}
	prepared := false
	defer func() {
		if !prepared {
			_ = os.RemoveAll(workDir)
		}
	}()
	archive, err := os.Open(staged.archive)
	if err != nil {
		return err
	}
	hash := sha256.New()
	n, copyErr := io.Copy(hash, io.LimitReader(contextReader{ctx, archive}, staged.artifact.Size+1))
	_ = archive.Close()
	if ctx.Err() != nil {
		return ErrPreparationTimeout
	}
	if copyErr != nil || n != staged.artifact.Size || !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), staged.artifact.SHA256) {
		return ErrTampered
	}
	payloadPath := filepath.Join(workDir, "payload")
	e.setPhase("extracting")
	if err := extractSecureZipWithProgress(ctx, staged.archive, payloadPath, defaultExtractLimits(), func(completed, total int) {
		e.set(func(state *UpdateState) { state.CompletedFiles, state.TotalFiles = completed, total })
	}); err != nil {
		if ctx.Err() != nil {
			return ErrPreparationTimeout
		}
		return err
	}
	e.setPhase("preparing")
	if err := validateExtractedLayout(payloadPath, staged.platform); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidArchive, err)
	}
	if ctx.Err() != nil {
		return ErrPreparationTimeout
	}
	req := HelperRequest{
		DataDir:        e.dataDir,
		Schema:         helperRequestSchema,
		ParentPID:      parentPID,
		Platform:       staged.platform,
		TargetPath:     target.Path,
		StagedPath:     payloadPath,
		BackupPath:     filepath.Join(workDir, "backup"),
		PreparedPath:   filepath.Join(workDir, "prepared"),
		ResultPath:     filepath.Join(workDir, "result.json"),
		WaitTimeoutSec: 120,
	}
	if e.helper != nil {
		go func() { _ = e.helper(req) }()
		err := waitForPrepared(ctx, req.PreparedPath, 5*time.Second)
		prepared = err == nil
		return err
	}
	requestPath := filepath.Join(workDir, "request.json")
	data, err := json.Marshal(req)
	if err != nil {
		return err
	}
	if err := os.WriteFile(requestPath, data, 0o600); err != nil {
		return err
	}
	helperPath := filepath.Join(workDir, helperFileName())
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if err := copyFile(exe, helperPath); err != nil {
		return err
	}
	if err := os.Chmod(helperPath, 0o755); err != nil && runtime.GOOS != "windows" {
		return err
	}
	cmd := exec.Command(helperPath, helperFlag, requestPath)
	cmd.Dir = workDir
	cmd.SysProcAttr = detachedSysProcAttr()
	logFile, err := os.OpenFile(filepath.Join(workDir, "helper.log"), os.O_CREATE|os.O_WRONLY, 0o600)
	if err == nil {
		defer logFile.Close()
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := waitForPrepared(ctx, req.PreparedPath, 15*time.Second); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	e.mu.Lock()
	e.helperProc = cmd.Process
	done := make(chan error, 1)
	e.helperDone = done
	e.mu.Unlock()
	go func() { done <- cmd.Wait() }()
	prepared = true
	return nil
}

// Resolve existing ancestors too: a not-yet-created data directory may sit
// under a symlink (notably /var on macOS).
func physicalPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil {
		return resolved, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	parent := filepath.Dir(abs)
	if parent == abs {
		return "", err
	}
	resolved, err = physicalPath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(abs)), nil
}

func helperFileName() string {
	if runtime.GOOS == "windows" {
		return "BeefTV-update-helper.exe"
	}
	return "BeefTV-update-helper"
}

func waitForPrepared(ctx context.Context, path string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := os.Stat(path); err == nil {
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fmt.Errorf("安装准备超时")
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	perm := info.Mode().Perm()
	if perm == 0 {
		perm = 0o755
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
