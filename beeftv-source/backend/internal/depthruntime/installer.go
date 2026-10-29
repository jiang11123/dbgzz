package depthruntime

import (
	"archive/zip"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Manifest struct {
	Version  int                 `json:"version"`
	Runtime  Artifact            `json:"runtime,omitempty"`
	Runtimes map[string]Artifact `json:"runtimes,omitempty"`
	Model    Artifact            `json:"model"`
}

type EnsureOptions struct {
	ManifestURL      string
	ManifestMirrors  []string
	DataDir          string
	Platform         string
	Variant          string
	TrustedPublicKey ed25519.PublicKey
	Progress         func(component string, progress Progress)
	FallbackManifest *Manifest
	// Offline forbids manifest requests and component downloads during capture.
	Offline bool
	// ApprovedPlan bounds the user's confirmed download and temporary-space budget.
	ApprovedPlan *Plan
}

type Installation struct {
	Python       string
	ToolDir      string
	ModelRuntime string
}

type runtimePaths struct {
	Root          string
	Python        string
	BundledPython string
	ToolDir       string
	Archive       string
}

// The desktop has one installer; variants share both downloads and model files.
// Serialize installation (not inference), and allow queued tasks to cancel.
var installationSlot = make(chan struct{}, 1)

func runtimeLayout(dataDir, platform, variant string) (runtimePaths, error) {
	if platform == "" {
		platform = "darwin-arm64"
	}
	switch {
	case platform == "darwin-arm64" && (variant == "" || variant == "mps"):
		root := filepath.Join(dataDir, "runtimes", "depth", "v1", "darwin-arm64")
		return runtimePaths{
			Root: root, Python: filepath.Join(root, ".venv", "bin", "python"),
			BundledPython: filepath.Join(root, ".python", "bin", "python3.11"),
			ToolDir:       filepath.Join(root, "worker"),
			Archive:       filepath.Join(dataDir, "downloads", "depth-runtime-v1-darwin-arm64.zip"),
		}, nil
	case platform == "windows-amd64" && (variant == "cpu" || variant == "cuda"):
		root := filepath.Join(dataDir, "runtimes", "depth", "v1", platform, variant)
		python := filepath.Join(root, ".python", "python.exe")
		return runtimePaths{
			Root: root, Python: python, BundledPython: python,
			ToolDir: filepath.Join(root, "worker"),
			Archive: filepath.Join(dataDir, "downloads", "depth-runtime-v1-windows-amd64-"+variant+".zip"),
		}, nil
	default:
		return runtimePaths{}, fmt.Errorf("不支持的深度运行包平台或设备: %s/%s", platform, variant)
	}
}

func Ensure(ctx context.Context, options EnsureOptions) (Installation, error) {
	if options.Offline {
		return Inspect(ctx, options.DataDir, options.Platform, options.Variant)
	}
	select {
	case installationSlot <- struct{}{}:
		defer func() { <-installationSlot }()
	case <-ctx.Done():
		return Installation{}, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return Installation{}, err
	}
	paths, err := runtimeLayout(options.DataDir, options.Platform, options.Variant)
	if err != nil {
		return Installation{}, err
	}
	windows := options.Platform == "windows-amd64"
	manifest, runtimeArtifact, err := loadArtifacts(ctx, options)
	if err != nil {
		return Installation{}, err
	}
	runtimeRoot := paths.Root
	modelRuntime := filepath.Join(options.DataDir, "models", "video-depth-anything-small", "v1")
	python := paths.Python
	toolDir := paths.ToolDir
	modelPath := filepath.Join(modelRuntime, "checkpoints", "video_depth_anything_vits.pth")
	archivePath := paths.Archive
	runtimeReady := installedRuntime(paths, options.Platform)
	archiveReady := runtimeReady || verifyFileContext(ctx, archivePath, runtimeArtifact) == nil
	plan, err := installationPlan(options.DataDir, runtimeArtifact, manifest.Model, archiveReady, verifyFileContext(ctx, modelPath, manifest.Model) == nil, runtimeReady)
	if err != nil {
		return Installation{}, fmt.Errorf("无法读取组件目录的可用空间: %w", err)
	}
	if approved := options.ApprovedPlan; approved != nil && (plan.DownloadBytes > approved.DownloadBytes || plan.RequiredBytes > approved.RequiredBytes) {
		return Installation{}, errors.New("组件下载信息已变化，请重新检查大小和空间后再确认下载")
	}
	if plan.RequiredBytes > 0 && plan.FreeBytes < uint64(plan.RequiredBytes) {
		return Installation{}, fmt.Errorf("磁盘空间不足，请先在设置中更换存储目录或释放空间：需预留 %.1f GB，当前可用 %.1f GB", float64(plan.RequiredBytes)/(1<<30), float64(plan.FreeBytes)/(1<<30))
	}
	if !runtimeReady {
		if !archiveReady {
			if err := Download(ctx, runtimeArtifact, archivePath, componentProgress(options.Progress, "runtime")); err != nil {
				return Installation{}, err
			}
		}
		if err := os.MkdirAll(filepath.Dir(runtimeRoot), 0o750); err != nil {
			return Installation{}, err
		}
		stage, err := os.MkdirTemp(filepath.Dir(runtimeRoot), ".depth-runtime-stage-*")
		if err != nil {
			return Installation{}, err
		}
		defer os.RemoveAll(stage)
		maxExpanded := int64(3 << 30)
		if windows {
			maxExpanded = 12 << 30
		}
		if options.Progress != nil {
			options.Progress("extracting", Progress{})
		}
		if err := extractRuntimeArchiveContext(ctx, archivePath, stage, runtimeArtifact, maxExpanded); err != nil {
			return Installation{}, err
		}
		if windows {
			if !pathRegular(filepath.Join(stage, ".python", "python.exe")) {
				return Installation{}, errors.New("深度组件缺少 Windows Python")
			}
		} else {
			if err := os.Chmod(filepath.Join(stage, ".venv", "bin", "python"), 0o750); err != nil {
				return Installation{}, fmt.Errorf("深度组件缺少可执行 Python: %w", err)
			}
			if !pathExecutable(filepath.Join(stage, ".python", "bin", "python3.11")) {
				return Installation{}, errors.New("深度组件内置 Python 不可执行")
			}
		}
		if err := ctx.Err(); err != nil {
			return Installation{}, err
		}
		if windows {
			if err := publishWindowsRuntime(stage, runtimeRoot); err != nil {
				return Installation{}, err
			}
		} else {
			_ = os.RemoveAll(runtimeRoot)
			if err := os.Rename(stage, runtimeRoot); err != nil {
				return Installation{}, fmt.Errorf("发布深度组件失败: %w", err)
			}
		}
	}
	if verifyFileContext(ctx, modelPath, manifest.Model) != nil {
		if err := Download(ctx, manifest.Model, modelPath, componentProgress(options.Progress, "model")); err != nil {
			return Installation{}, err
		}
	}
	receipt, err := json.Marshal(Artifact{Size: manifest.Model.Size, SHA256: manifest.Model.SHA256})
	if err != nil {
		return Installation{}, err
	}
	if err := os.WriteFile(filepath.Join(runtimeRoot, ".installation.json"), receipt, 0600); err != nil {
		return Installation{}, err
	}
	return Installation{Python: python, ToolDir: toolDir, ModelRuntime: modelRuntime}, nil
}

func publishWindowsRuntime(stage, root string) error {
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		return os.Rename(stage, root)
	} else if err != nil {
		return err
	}
	backupDir, err := os.MkdirTemp(filepath.Dir(root), ".depth-runtime-backup-*")
	if err != nil {
		return err
	}
	backup := filepath.Join(backupDir, "previous")
	if err := os.Rename(root, backup); err != nil {
		_ = os.Remove(backupDir)
		return fmt.Errorf("旧版深度组件仍被占用，无法安全替换: %w", err)
	}
	if err := os.Rename(stage, root); err != nil {
		if restoreErr := os.Rename(backup, root); restoreErr != nil {
			return fmt.Errorf("发布深度组件失败: %w；旧版保留在 %s，自动恢复失败: %v", err, backup, restoreErr)
		}
		_ = os.Remove(backupDir)
		return fmt.Errorf("发布深度组件失败，旧版已恢复: %w", err)
	}
	_ = os.RemoveAll(backupDir)
	return nil
}

func fetchManifest(ctx context.Context, rawURL string, signed bool, public ed25519.PublicKey) (Manifest, error) {
	if strings.TrimSpace(rawURL) == "" {
		return Manifest{}, errors.New("未配置深度组件下载清单")
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		req, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, rawURL, nil)
		if err != nil {
			cancel()
			return Manifest{}, err
		}
		response, err := downloadClient.Do(req)
		if err != nil {
			cancel()
			lastErr = err
			continue
		}
		var manifest Manifest
		if response.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("深度组件清单返回 HTTP %d", response.StatusCode)
			_ = response.Body.Close()
			cancel()
			continue
		}
		var decodeErr error
		if signed {
			var raw []byte
			raw, decodeErr = io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
			if decodeErr == nil && len(raw) > 1<<20 {
				decodeErr = errors.New("深度组件清单超过大小限制")
			}
			if decodeErr == nil {
				manifest, decodeErr = verifySignedManifest(raw, public)
			}
		} else {
			decodeErr = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&manifest)
		}
		_ = response.Body.Close()
		cancel()
		if decodeErr != nil {
			lastErr = fmt.Errorf("解析深度组件清单失败: %w", decodeErr)
			continue
		}
		return manifest, nil
	}
	return Manifest{}, fmt.Errorf("获取深度组件清单失败: %w", lastErr)
}

func fetchManifestSources(ctx context.Context, options EnsureOptions) (Manifest, error) {
	sources := append([]string{options.ManifestURL}, options.ManifestMirrors...)
	var lastErr error
	for _, source := range sources {
		attemptCtx := ctx
		cancel := func() {}
		if len(sources) > 1 {
			attemptCtx, cancel = context.WithTimeout(ctx, 6*time.Second)
		}
		manifest, err := fetchManifest(attemptCtx, source, options.Platform == "windows-amd64", options.TrustedPublicKey)
		cancel()
		if err == nil {
			return manifest, nil
		}
		if ctx.Err() != nil {
			return Manifest{}, ctx.Err()
		}
		lastErr = err
	}
	return Manifest{}, lastErr
}

func extractRuntimeArchive(path string, destination string, artifact Artifact, maxExpanded int64) error {
	return extractRuntimeArchiveContext(context.Background(), path, destination, artifact, maxExpanded)
}

func extractRuntimeArchiveContext(ctx context.Context, path string, destination string, artifact Artifact, maxExpanded int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	reader, err := zip.OpenReader(path)
	if err != nil {
		return fmt.Errorf("打开深度组件压缩包失败: %w", err)
	}
	defer reader.Close()
	var declaredExpanded int64
	for _, entry := range reader.File {
		declaredExpanded += int64(entry.UncompressedSize64)
	}
	if err := validateArchiveShape(len(reader.File), declaredExpanded, artifact, maxExpanded); err != nil {
		return err
	}
	var expanded int64
	for _, entry := range reader.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		// .NET Framework ZIPs use Windows separators. Normalize before all
		// containment checks so traversal stays forbidden on every host.
		portableName := strings.ReplaceAll(entry.Name, `\`, "/")
		if strings.Contains(portableName, ":") || strings.HasPrefix(portableName, "/") {
			return errors.New("深度组件压缩包包含非安全路径")
		}
		clean := filepath.Clean(filepath.FromSlash(portableName))
		if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return errors.New("深度组件压缩包包含越界路径")
		}
		if entry.Mode()&os.ModeSymlink != 0 {
			return errors.New("深度组件压缩包不允许符号链接")
		}
		expanded += int64(entry.UncompressedSize64)
		if expanded > maxExpanded {
			return errors.New("深度组件解压体积超过限制")
		}
		target := filepath.Join(destination, clean)
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o750); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
			return err
		}
		source, err := entry.Open()
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
		if err != nil {
			source.Close()
			return err
		}
		_, copyErr := io.Copy(output, contextReader{ctx, source})
		closeErr := output.Close()
		source.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if entry.Mode().Perm()&0o111 != 0 {
			if err := os.Chmod(target, 0o750); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateArchiveShape(files int, expandedSize int64, artifact Artifact, maxExpanded int64) error {
	if files > 50_000 {
		return errors.New("深度组件压缩包文件数量超过安全上限")
	}
	if expandedSize > maxExpanded {
		return errors.New("深度组件解压体积超过安全上限")
	}
	if artifact.Files > 0 && files != artifact.Files {
		return fmt.Errorf("深度组件压缩包文件数量与发布清单不一致: got %d want %d", files, artifact.Files)
	}
	if artifact.ExpandedSize > 0 && expandedSize != artifact.ExpandedSize {
		return fmt.Errorf("深度组件解压体积与发布清单不一致: got %d want %d", expandedSize, artifact.ExpandedSize)
	}
	return nil
}

func componentProgress(report func(string, Progress), component string) func(Progress) {
	if report == nil {
		return nil
	}
	return func(progress Progress) { report(component, progress) }
}

func fileMatches(path string, artifact Artifact) bool { return verifyFile(path, artifact) == nil }
func pathExists(path string) bool                     { _, err := os.Stat(path); return err == nil }
func pathExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}
func pathRegular(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}
