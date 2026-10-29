package runtimeinfo

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func descriptorLocation(dataDir string) (string, string, error) {
	if strings.TrimSpace(dataDir) == "" {
		return "", "", errors.New("数据目录不能为空")
	}
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return "", "", fmt.Errorf("定位工作区数据目录: %w", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", fmt.Errorf("定位用户目录: %w", err)
	}
	if !filepath.IsAbs(home) {
		return "", "", errors.New("用户目录必须是绝对路径")
	}
	// MSIX opens AppData files from its private copy first, even for absolute
	// paths. Use one shared location outside AppData, never a legacy fallback.
	digest := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(abs))))
	dataDirHash := hex.EncodeToString(digest[:])
	return filepath.Join(home, ".beeftv", "runtime", dataDirHash+".json"), dataDirHash, nil
}
