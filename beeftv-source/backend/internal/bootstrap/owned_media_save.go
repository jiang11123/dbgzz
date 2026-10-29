package bootstrap

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
	"unicode/utf8"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
)

const maxSaveFileNameBytes = 180

// Wails v2 JSON-unmarshals []byte from a base64 string. JS strings are UTF-16,
// so 32MiB raw is about 43MiB base64 and ~86MiB of string memory plus the
// original ArrayBuffer and the IPC copy. Larger caps still risk the WebView.
const maxOwnedArtifactBytes = 32 << 20

func (r *Runtime) CopyOwnedResourceTo(resourceID, destPath string) error {
	if r == nil || r.service == nil {
		return errors.New("本地后端尚未就绪")
	}
	id, err := sanitizeOwnedResourceID(resourceID)
	if err != nil {
		return err
	}
	dest, err := sanitizeSaveDestination(destPath)
	if err != nil {
		return err
	}
	owner, err := r.service.LocalWorkspaceOwner()
	if err != nil {
		return err
	}
	resource, err := r.service.Resource(owner.ID, id)
	if err != nil {
		return errors.New("没有可导出的本机文件")
	}
	src, err := openLocalOwnedResourceFile(resource, r.cfg.DataDir)
	if err != nil {
		return err
	}
	defer src.Close()
	return writeOwnedFileAtomically(dest, src, src)
}

func WriteOwnedArtifact(dest string, data []byte) error {
	if len(data) == 0 {
		return errors.New("没有可导出的文件")
	}
	if len(data) > maxOwnedArtifactBytes {
		return errors.New("导出包太大，请减少所选内容后再导出")
	}
	dest, err := sanitizeSaveDestination(dest)
	if err != nil {
		return err
	}
	return writeOwnedFileAtomically(dest, bytes.NewReader(data), nil)
}

func openLocalOwnedResourceFile(resource *model.Resource, dataDir string) (*os.File, error) {
	if resource == nil || resource.Provider != "local" || resource.Status != model.ResourceStatusReady {
		return nil, errors.New("没有可导出的本机文件")
	}
	return localasset.NewFileStore(dataDir).Open(resource.ObjectKey)
}

func writeOwnedFileAtomically(dest string, body io.Reader, src *os.File) (returnErr error) {
	return writeOwnedFileWith(dest, src, func(writer io.Writer) error {
		_, err := io.Copy(writer, body)
		return err
	})
}

func writeOwnedFileWith(dest string, src *os.File, write func(io.Writer) error) (returnErr error) {
	if err := rejectSameFile(src, dest); err != nil {
		return err
	}
	directory := filepath.Dir(dest)
	temporary, err := os.CreateTemp(directory, ".beeftv-save-*")
	if err != nil {
		return errors.New("无法写入所选位置")
	}
	temporaryPath := temporary.Name()
	defer func() {
		if returnErr != nil {
			_ = temporary.Close()
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		return errors.New("无法写入所选位置")
	}
	if err := write(temporary); err != nil {
		return errors.New("无法写出文件")
	}
	if err := temporary.Sync(); err != nil {
		return errors.New("无法写出文件")
	}
	if err := temporary.Close(); err != nil {
		return errors.New("无法写出文件")
	}
	if err := replaceFile(temporaryPath, dest); err != nil {
		return err
	}
	return nil
}

func rejectSameFile(src *os.File, dest string) error {
	if src == nil {
		return nil
	}
	destInfo, err := os.Stat(dest)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return errors.New("无法写入所选位置")
	}
	srcInfo, err := src.Stat()
	if err != nil {
		return errors.New("没有可导出的本机文件")
	}
	if os.SameFile(srcInfo, destInfo) {
		return errors.New("不能覆盖正在导出的原文件")
	}
	return nil
}

func replaceFile(tmpPath, dest string) error {
	// On Windows, os.Rename uses MoveFileEx with MOVEFILE_REPLACE_EXISTING
	// (Go 1.5+). Do not delete dest+suffix or swap through a sidecar: that can
	// erase an unrelated user file and leave dest missing if restore fails.
	if err := os.Rename(tmpPath, dest); err != nil {
		return errors.New("无法保存到所选位置")
	}
	return nil
}

func sanitizeOwnedResourceID(resourceID string) (string, error) {
	id := strings.TrimSpace(resourceID)
	if id == "" || len(id) > 128 {
		return "", errors.New("没有可导出的本机文件")
	}
	if strings.ContainsAny(id, "/\\:") || strings.Contains(id, "..") {
		return "", errors.New("没有可导出的本机文件")
	}
	for _, r := range id {
		if r < 33 || r > 126 || unicode.IsSpace(r) {
			return "", errors.New("没有可导出的本机文件")
		}
	}
	return id, nil
}

func SanitizeSaveFileName(name string) string {
	return sanitizeSaveFileName(name)
}

func sanitizeSaveFileName(name string) string {
	base := filepath.Base(strings.TrimSpace(name))
	base = strings.ReplaceAll(base, "\x00", "")
	if base == "" || base == "." || base == ".." {
		return "未命名媒体"
	}
	var builder strings.Builder
	for _, r := range base {
		if r < 32 || strings.ContainsRune(`\/:*?"<>|`, r) {
			builder.WriteByte('_')
			continue
		}
		builder.WriteRune(r)
	}
	cleaned := strings.Trim(builder.String(), " .")
	if cleaned == "" || cleaned == "." || cleaned == ".." {
		return "未命名媒体"
	}
	return limitSaveFileName(cleaned)
}

func limitSaveFileName(name string) string {
	if len(name) <= maxSaveFileNameBytes {
		return name
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	budget := maxSaveFileNameBytes - len(ext)
	if budget < 1 {
		trimmed := strings.TrimRight(truncateToUTF8Bytes(name, maxSaveFileNameBytes), " .")
		if trimmed == "" {
			return "未命名媒体"
		}
		return trimmed
	}
	truncated := strings.TrimRight(truncateToUTF8Bytes(base, budget), " .")
	if truncated == "" {
		return "未命名媒体" + ext
	}
	return truncated + ext
}

func truncateToUTF8Bytes(value string, maxBytes int) string {
	if maxBytes <= 0 || value == "" {
		return ""
	}
	if len(value) <= maxBytes {
		return value
	}
	for maxBytes > 0 && !utf8.RuneStart(value[maxBytes]) {
		maxBytes--
	}
	return value[:maxBytes]
}

func sanitizeSaveDestination(destPath string) (string, error) {
	dest := strings.TrimSpace(destPath)
	if dest == "" {
		return "", errors.New("没有选择保存位置")
	}
	dest = filepath.Clean(dest)
	info, err := os.Stat(dest)
	if err == nil && info.IsDir() {
		return "", errors.New("保存位置不能是文件夹")
	}
	return dest, nil
}
