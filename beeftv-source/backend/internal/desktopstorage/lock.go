package desktopstorage

import (
	"errors"
	"os"
	"path/filepath"
)

// Keep the lock beside the workspace so copying or deleting its contents cannot
// replace the locked inode. All local runtimes must acquire it before opening DB.
func Lock(path string) (*os.File, error) {
	path, err := canonical(path)
	if err != nil {
		return nil, err
	}
	return LockFile(filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".beeftv-lock"))
}

// LockFile lets the host place a lock outside Windows AppData virtualization.
func LockFile(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(file); err != nil {
		file.Close()
		return nil, errors.New("此数据目录正在被另一实例使用，请先关闭其他 BeefTV 窗口")
	}
	return file, nil
}

func Overlaps(left, right string) (bool, error) {
	left, err := canonical(left)
	if err != nil {
		return false, err
	}
	right, err = canonical(right)
	if err != nil {
		return false, err
	}
	return contains(left, right) || contains(right, left), nil
}
