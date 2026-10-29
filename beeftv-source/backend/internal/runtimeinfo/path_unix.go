//go:build !windows

package runtimeinfo

import (
	"errors"
	"path/filepath"
	"strings"
)

func descriptorLocation(dataDir string) (string, string, error) {
	if strings.TrimSpace(dataDir) == "" {
		return "", "", errors.New("数据目录不能为空")
	}
	return filepath.Join(dataDir, FileName), "", nil
}
