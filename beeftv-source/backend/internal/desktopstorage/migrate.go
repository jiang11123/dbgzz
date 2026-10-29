package desktopstorage

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

type Usage struct {
	DataDir       string `json:"dataDir"`
	UsedBytes     int64  `json:"usedBytes"`
	FreeBytes     uint64 `json:"freeBytes"`
	PreviousDir   string `json:"previousDir,omitempty"`
	PreviousBytes int64  `json:"previousBytes,omitempty"`
}

// FreeBytes reads volume capacity without walking project and media files.
func FreeBytes(path string) (uint64, error) {
	for {
		_, err := os.Stat(path)
		if err == nil {
			return freeBytes(path)
		}
		if !os.IsNotExist(err) || filepath.Dir(path) == path {
			return 0, err
		}
		path = filepath.Dir(path)
	}
}

func Inspect(path string) (Usage, error) {
	return inspect(path, false)
}

func inspect(path string, migrating bool) (Usage, error) {
	usage := Usage{DataDir: path}
	err := filepath.WalkDir(path, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if migrating && skipScratch(path, name, entry) {
			return filepath.SkipDir
		}
		if entry.Type().IsRegular() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			usage.UsedBytes += info.Size()
		}
		return nil
	})
	if err != nil {
		return usage, err
	}
	usage.FreeBytes, err = freeBytes(path)
	return usage, err
}

func Validate(source, target string) (string, error) {
	source, err := canonical(source)
	if err != nil {
		return "", err
	}
	target, err = canonical(target)
	if err != nil {
		return "", err
	}
	if contains(source, target) || contains(target, source) {
		return "", errors.New("新目录不能与当前数据目录重叠")
	}
	entries, err := os.ReadDir(target)
	if err == nil && len(entries) != 0 {
		return "", errors.New("请选择空文件夹，避免覆盖已有文件")
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := os.MkdirAll(target, 0700); err != nil {
		return "", fmt.Errorf("新目录无法写入: %w", err)
	}
	probe, err := os.CreateTemp(target, ".beeftv-write-check-*")
	if err != nil {
		return "", fmt.Errorf("新目录无法写入: %w", err)
	}
	probeName := probe.Name()
	closeErr := probe.Close()
	_ = os.Remove(probeName)
	if closeErr != nil {
		return "", closeErr
	}
	usage, err := inspect(source, true)
	if err != nil {
		return "", err
	}
	available, err := freeBytes(target)
	if err != nil {
		return "", err
	}
	if available < uint64(usage.UsedBytes)+(16<<20) {
		return "", errors.New("目标磁盘空间不足，请选择其他磁盘")
	}
	return target, nil
}

// Caller must stop all writers and close SQLite first. Copy into a private stage,
// compare every file, then publish the directory. The source remains untouched.
func CopyClosedWorkspace(ctx context.Context, source, target string, observers ...func(Progress)) error {
	progress := Progress{Phase: "preparing", Detail: "正在统计待迁移文件"}
	observe := func() {
		if len(observers) > 0 && observers[0] != nil {
			observers[0](progress)
		}
	}
	observe()
	target, err := Validate(source, target)
	if err != nil {
		return err
	}
	if len(observers) > 0 {
		err = filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if skipScratch(source, path, entry) {
				return filepath.SkipDir
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if entry.Type().IsRegular() {
				info, err := entry.Info()
				if err != nil {
					return err
				}
				progress.TotalBytes += info.Size()
				progress.TotalFiles++
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	stage, err := os.MkdirTemp(filepath.Dir(target), ".beeftv-migrate-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	err = filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if skipScratch(source, path, entry) {
			return filepath.SkipDir
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("数据目录包含链接，请先处理后再迁移：%s", rel)
		}
		dest := filepath.Join(stage, rel)
		if entry.IsDir() {
			return os.MkdirAll(dest, info.Mode().Perm())
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("无法迁移特殊文件：%s", rel)
		}
		progress.Phase, progress.Detail = "transferring", "正在复制文件"
		observe()
		copyErr := copyVerified(ctx, path, dest, info.Mode().Perm(), func(bytes int64) {
			progress.LoadedBytes += bytes
			observe()
		}, func() { progress.Phase, progress.Detail = "processing", "正在校验已复制的文件"; observe() })
		if copyErr == nil {
			progress.CompletedFiles++
			observe()
		}
		return copyErr
	})
	if err != nil {
		return err
	}
	// Recheck instead of deleting anything a different process may have put here.
	entries, err := os.ReadDir(target)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return errors.New("目标目录已有文件，迁移已停止")
	}
	if err := os.Remove(target); err != nil {
		return err
	}
	return os.Rename(stage, target)
}

func copyVerified(ctx context.Context, source, dest string, mode fs.FileMode, copied func(int64), verifying func()) error {
	in, err := openMigrationFile(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	hash := sha256.New()
	buffer := make([]byte, 256<<10)
	for {
		if err := ctx.Err(); err != nil {
			_ = out.Close()
			return err
		}
		n, readErr := in.Read(buffer)
		if n > 0 {
			hash.Write(buffer[:n])
			if _, err = out.Write(buffer[:n]); err != nil {
				_ = out.Close()
				return err
			}
			if copied != nil {
				copied(int64(n))
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			_ = out.Close()
			return readErr
		}
	}
	if err = out.Sync(); err != nil {
		_ = out.Close()
		return err
	}
	if err = out.Close(); err != nil {
		return err
	}
	check, err := os.Open(dest)
	if err != nil {
		return err
	}
	defer check.Close()
	verified := sha256.New()
	if verifying != nil {
		verifying()
	}
	if _, err = io.Copy(verified, check); err != nil {
		return err
	}
	if string(hash.Sum(nil)) != string(verified.Sum(nil)) {
		return errors.New("迁移文件校验失败，原数据已保留")
	}
	return nil
}
