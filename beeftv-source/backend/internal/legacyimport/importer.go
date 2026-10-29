package legacyimport

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type Result struct {
	Imported bool
	Source   string
	Target   string
}

type Importer struct {
	// Validate runs against the private temporary copy before publication.
	// Callers may open/migrate that copy transactionally without touching the
	// user's original legacy database.
	Validate func(string) error
}

func (i Importer) Import(source, destination string) (Result, error) {
	result := Result{Source: source, Target: destination}
	if source == "" || destination == "" || filepath.Clean(source) == filepath.Clean(destination) {
		return result, errors.New("旧数据库来源和本地目标必须是不同文件")
	}
	sourceHash, err := fileHash(source)
	if err != nil {
		return result, fmt.Errorf("读取旧数据库: %w", err)
	}
	if destinationHash, hashErr := fileHash(destination); hashErr == nil {
		if destinationHash == sourceHash {
			return result, nil
		}
		return result, errors.New("本地目标已存在且与旧数据库不同，拒绝覆盖")
	} else if !errors.Is(hashErr, os.ErrNotExist) {
		return result, hashErr
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return result, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".legacy-import-*")
	if err != nil {
		return result, err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return result, err
	}
	src, err := os.Open(source)
	if err != nil {
		_ = tmp.Close()
		return result, err
	}
	_, copyErr := io.Copy(tmp, src)
	closeSourceErr := src.Close()
	syncErr := tmp.Sync()
	closeErr := tmp.Close()
	if err := errors.Join(copyErr, closeSourceErr, syncErr, closeErr); err != nil {
		return result, err
	}
	if i.Validate != nil {
		if err := i.Validate(tmpPath); err != nil {
			return result, fmt.Errorf("验证旧数据库副本: %w", err)
		}
	}
	if err := os.Rename(tmpPath, destination); err != nil {
		return result, err
	}
	result.Imported = true
	return result, nil
}

func fileHash(path string) ([32]byte, error) {
	var zero [32]byte
	file, err := os.Open(path)
	if err != nil {
		return zero, err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return zero, err
	}
	var result [32]byte
	copy(result[:], hash.Sum(nil))
	return result, nil
}
