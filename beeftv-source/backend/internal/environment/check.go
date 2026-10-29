// Package environment runs bounded local checks. Case records are references,
// never executable repair instructions or a remotely updated policy.
package environment

import (
	"context"
	"crypto/rand"
	"errors"
	"os"
	"runtime"
	"time"

	"infinite-canvas/backend/internal/desktopnet"
	"infinite-canvas/backend/internal/mediatools"
)

type Check struct {
	ID     string   `json:"id"`
	Title  string   `json:"title"`
	Status string   `json:"status"`
	Detail string   `json:"detail"`
	Cases  []string `json:"cases"`
}

type Report struct {
	CheckedAt time.Time   `json:"checkedAt"`
	OS        string      `json:"os"`
	Arch      string      `json:"arch"`
	Catalog   CaseCatalog `json:"catalog"`
	Checks    []Check     `json:"checks"`
}

// Inspect never accepts a path from HTTP. The already-open workspace owns dir.
// Repair only recreates missing scratch/download directories; existing files,
// permissions, projects, credentials and system settings are left alone.
func Inspect(ctx context.Context, dir string, repair bool) Report {
	r := Report{CheckedAt: time.Now().UTC(), OS: runtime.GOOS, Arch: runtime.GOARCH, Catalog: catalog(), Checks: []Check{}}
	add := func(id, title, status, detail string, cases ...string) {
		r.Checks = append(r.Checks, Check{id, title, status, detail, cases})
	}
	stop := func() bool {
		if ctx.Err() == nil {
			return false
		}
		add("check-cancelled", "环境检查", "unknown", "检查已取消，尚未完成的项目保持未确认。")
		return true
	}
	if stop() {
		return r
	}
	if dir == "" {
		add("workspace", "本地存储", "skipped", "当前服务未提供本机工作区检查。", "ENV-0007")
		return r
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		add("workspace", "本地存储", "error", "无法打开当前数据目录。请检查磁盘连接和访问权限，不要新建空目录替代原项目。", "ENV-0007")
		return r
	}
	defer root.Close()
	if stop() {
		return r
	}
	if err := probeWrite(ctx, root); err != nil {
		if stop() {
			return r
		}
		add("storage-write", "存储写入", "error", "当前数据目录无法完成文件写入和同步。请检查磁盘空间、权限或只读状态。", "ENV-0009")
	} else {
		add("storage-write", "存储写入", "pass", "已完成临时文件写入、同步和清理。", "ENV-0009")
	}
	if stop() {
		return r
	}
	free, err := freeBytes(dir)
	switch {
	case err != nil:
		add("disk-space", "磁盘剩余空间", "unknown", "无法读取剩余空间，未判定磁盘正常。", "ENV-0009")
	case free < 1<<30:
		add("disk-space", "磁盘剩余空间", "warning", "可用空间不足 1 GB，下载或保存大文件可能失败。请释放空间或在存储设置中迁移目录。", "ENV-0009", "ENV-0022")
	default:
		add("disk-space", "磁盘剩余空间", "pass", "当前可用空间超过 1 GB；大型素材和组件仍需要额外空间。", "ENV-0009")
	}
	for _, name := range []string{"tmp", "downloads"} {
		if stop() {
			return r
		}
		status, detail := scratchDirectory(ctx, root, name, repair)
		add("directory-"+name, map[string]string{"tmp": "临时文件目录", "downloads": "组件下载目录"}[name], status, detail, "ENV-0006", "ENV-0046")
	}
	if stop() {
		return r
	}
	path, err := mediatools.ResolveFFmpeg()
	info, statErr := os.Stat(path)
	if err != nil || statErr != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0) {
		add("media-tool", "视频处理工具", "warning", "未找到可执行的视频处理工具。部分视频预览、转码和导出将不可用，请从官方安装包重新安装。", "ENV-0014", "ENV-0015", "ENV-0016")
	} else {
		add("media-tool", "视频处理工具", "pass", "已找到工具文件；具体素材的编解码能力仍在使用时检查。", "ENV-0014", "ENV-0015")
	}
	if stop() {
		return r
	}
	model, err := root.Stat("models/video-depth-anything-small/v1/checkpoints/video_depth_anything_vits.pth")
	switch {
	case errors.Is(err, os.ErrNotExist):
		add("depth-model", "可选深度模型", "skipped", "尚未安装，首次使用深度动作捕捉时按官方清单下载和校验。", "ENV-0011")
	case err != nil || !model.Mode().IsRegular() || model.Size() != 116440756:
		add("depth-model", "可选深度模型", "warning", "模型文件不可读或大小不完整。再次使用深度动作捕捉时将由组件安装器校验并恢复；自检不会删除或下载模型。", "ENV-0011", "ENV-0046")
	default:
		add("depth-model", "可选深度模型", "pass", "模型文件大小正常，运行前仍需组件安装器校验哈希。", "ENV-0011")
	}
	if stop() {
		return r
	}
	proxy := desktopnet.ConfigurationStatus()
	if proxy.AutoConfigOnly {
		add("proxy", "下载代理", "warning", "系统仅配置了自动代理脚本，当前下载器不能解析。请配置可用的静态系统代理或明确的代理环境变量。", "ENV-0010", "ENV-0011")
	} else {
		add("proxy", "下载代理", "pass", map[string]string{"environment": "沿用明确配置的代理环境变量。", "system": "沿用系统静态代理，并向组件下载子进程传递。", "direct": "未发现静态代理配置，当前使用直连。"}[proxy.Mode]+"此项没有测试外网连通性。", "ENV-0010", "ENV-0011")
	}
	return r
}

func probeWrite(ctx context.Context, root *os.Root) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	name := ".beeftv-environment-" + rand.Text()
	f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write([]byte("environment-check"))
	syncErr := ctx.Err()
	if syncErr == nil {
		syncErr = f.Sync()
	}
	closeErr := f.Close()
	removeErr := root.Remove(name)
	return errors.Join(writeErr, syncErr, closeErr, removeErr)
}

func scratchDirectory(ctx context.Context, root *os.Root, name string, repair bool) (string, string) {
	info, err := root.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		if !repair {
			return "warning", "目录缺失，可由应用安全重建。"
		}
		if ctx.Err() != nil {
			return "unknown", "检查已取消，目录未重建。"
		}
		if err = root.Mkdir(name, 0o750); err != nil && !errors.Is(err, os.ErrExist) {
			return "error", "目录重建失败，请检查写入权限。"
		}
		info, err = root.Lstat(name)
		if err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
			return "repaired", "已重建缺失目录并复检；未改动已有文件。"
		}
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "error", "此位置不是普通目录或无法访问，未自动替换。"
	}
	return "pass", "目录存在，未改动已有内容。"
}
