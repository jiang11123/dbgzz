package desktopstorage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Snapshot contains hashes only, never file contents or credentials.
func Snapshot(dir string) (map[string]string, error) {
	files := make(map[string]string)
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if skipScratch(dir, path, entry) {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		if rel == locationFile {
			return nil
		}
		if !entry.Type().IsRegular() {
			return errors.New("数据目录含链接或特殊文件，无法清理或迁移")
		}
		file, err := openMigrationFile(path)
		if err != nil {
			return err
		}
		hash := sha256.New()
		_, err = io.Copy(hash, file)
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		files[rel] = hex.EncodeToString(hash.Sum(nil))
		return nil
	})
	return files, err
}

func VerifySnapshot(dir string, files map[string]string, allowMissing bool) error {
	current, err := Snapshot(dir)
	if err != nil {
		return err
	}
	for path, hash := range current {
		if files[path] != hash {
			return errors.New("原目录有新增或修改的数据，已停止清理，请保留并检查原目录")
		}
	}
	if !allowMissing && len(current) != len(files) {
		return errors.New("迁移文件数量不一致，原数据已保留")
	}
	return nil
}

func MigrationLocation(root, current string) (Location, error) {
	body, err := os.ReadFile(filepath.Join(root, locationFile))
	if errors.Is(err, os.ErrNotExist) {
		return Location{}, nil
	}
	if err != nil {
		return Location{}, err
	}
	var location Location
	if err = json.Unmarshal(body, &location); err != nil {
		return Location{}, err
	}
	resolved, err := canonical(current)
	if err != nil {
		return Location{}, err
	}
	stored, err := canonical(location.DataDir)
	if err != nil {
		return Location{}, err
	}
	if resolved != stored {
		return Location{}, nil
	}
	return location, nil
}

// Caller must refuse a live legacy runtime, whose version predates the lock.
// Verify all remaining source files before deleting any. Repeated cleanup after
// a filesystem failure is safe; changed or newly added files always stop it.
func CleanupPrevious(root, current string, acquireLock func(string) (*os.File, error)) error {
	location, err := MigrationLocation(root, current)
	if err != nil {
		return err
	}
	if location.PreviousDir == "" || len(location.PreviousFiles) == 0 {
		return errors.New("没有可自动清理的原目录")
	}
	overlaps, err := Overlaps(current, location.PreviousDir)
	if err != nil {
		return err
	}
	if overlaps {
		return errors.New("原目录与当前目录重叠，无法清理")
	}
	lock, err := acquireLock(location.PreviousDir)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = VerifySnapshot(location.PreviousDir, location.PreviousFiles, true); err != nil {
		return err
	}
	for rel := range location.PreviousFiles {
		// Snapshot paths are untrusted persisted data: prevent traversal.
		if !filepath.IsLocal(rel) || filepath.Clean(rel) != rel || rel == locationFile {
			return errors.New("迁移记录无效，无法清理")
		}
	}
	// A live desktop child can retain scratch handles after the workspace has
	// stopped. Handle scratch first, before deleting any durable copies, and
	// retain the receipt so cleanup can be retried after those handles close.
	if err = os.RemoveAll(filepath.Join(location.PreviousDir, "cache", "tmp")); err != nil {
		if fileInUse(err) {
			return fmt.Errorf("临时文件仍在使用中，请重启 BeefTV 后再次清理。当前存储目录不受影响\n\n%w", err)
		}
		return fmt.Errorf("临时文件未能清理，当前存储目录不受影响。请检查原目录的访问权限和磁盘状态\n\n%w", err)
	}
	for rel := range location.PreviousFiles {
		// Older receipts included scratch files; they are handled above.
		if strings.HasPrefix(rel, filepath.Join("cache", "tmp")+string(filepath.Separator)) {
			continue
		}
		if err = os.Remove(filepath.Join(location.PreviousDir, rel)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("原目录清理未完成，当前存储目录不受影响。请保留当前目录并检查错误详情\n\n%w", err)
		}
	}
	// Only remove empty directories. Keep the fixed profile pointer intact.
	var dirs []string
	_ = filepath.WalkDir(location.PreviousDir, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && entry.IsDir() {
			dirs = append(dirs, path)
		}
		return err
	})
	for i := len(dirs) - 1; i >= 0; i-- {
		_ = os.Remove(dirs[i])
	}
	return saveLocation(root, Location{DataDir: current})
}
