//go:build !windows

package privatefile

import (
	"errors"
	"os"
)

func Check(_ string, info os.FileInfo) error {
	if info.Mode().Perm()&0077 != 0 {
		return errors.New("投稿状态文件权限必须为0600")
	}
	return nil
}
func Protect(file *os.File) error { return file.Chmod(0600) }
