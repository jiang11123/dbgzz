package asset

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// FileStore owns the crash-safe filesystem boundary for local resource bytes.
// Callers persist metadata separately and may mark a resource ready only after
// Write has completed successfully.
type FileStore struct {
	root string
}

func NewFileStore(dataDir string) *FileStore {
	return &FileStore{root: canonicalPath(filepath.Join(strings.TrimSpace(dataDir), "resources"))}
}

func (s *FileStore) writeSpace() string {
	if s == nil {
		return ""
	}
	return canonicalPath(s.root)
}

// canonicalPath is the process-wide lock identity for a FileStore root.
// Abs+Clean alone splits trailing-slash and symlink aliases of the same
// directory; this walks up to the first existing path, EvalSymlinks it, then
// rejoins missing trailing components so NewFileStore can run before
// resources/ exists.
func canonicalPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	abs = filepath.Clean(abs)
	probe := abs
	var missing []string
	for {
		resolved, err := filepath.EvalSymlinks(probe)
		if err == nil {
			for index := len(missing) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missing[index])
			}
			return resolved
		}
		if !errors.Is(err, os.ErrNotExist) {
			return abs
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return abs
		}
		missing = append(missing, filepath.Base(probe))
		probe = parent
	}
}

func (s *FileStore) Write(objectKey string, body io.Reader) (returnErr error) {
	target, err := s.path(objectKey)
	if err != nil {
		return err
	}
	if body == nil {
		return errors.New("local resource body is nil")
	}
	directory := filepath.Dir(target)
	if err := s.ensureSafeParent(directory); err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return fmt.Errorf("create local resource directory: %w", err)
	}
	if err := s.ensureSafeParent(directory); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".beeftv-resource-*")
	if err != nil {
		return fmt.Errorf("create local resource temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() {
		if returnErr != nil {
			_ = temporary.Close()
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o640); err != nil {
		return fmt.Errorf("set local resource permissions: %w", err)
	}
	if _, err := io.Copy(temporary, body); err != nil {
		return fmt.Errorf("write local resource: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync local resource: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close local resource: %w", err)
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		return fmt.Errorf("publish local resource: %w", err)
	}
	if err := syncDirectory(directory); err != nil {
		return fmt.Errorf("sync local resource directory: %w", err)
	}
	return nil
}

func (s *FileStore) Open(objectKey string) (*os.File, error) {
	path, err := s.path(objectKey)
	if err != nil {
		return nil, err
	}
	if err := s.ensureSafeExistingPath(path); err != nil {
		return nil, err
	}
	return os.Open(path)
}

// Exists reports whether objectKey names a regular file inside the store.
func (s *FileStore) Exists(objectKey string) error {
	path, err := s.path(objectKey)
	if err != nil {
		return err
	}
	if err := s.ensureSafeExistingPath(path); err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errors.New("local resource path points to a directory")
	}
	return nil
}

func (s *FileStore) Delete(objectKey string) error {
	path, err := s.path(objectKey)
	if err != nil {
		return err
	}
	info, statErr := os.Lstat(path)
	if errors.Is(statErr, os.ErrNotExist) {
		if err := s.ensureSafeParent(filepath.Dir(path)); err != nil {
			return err
		}
		return nil
	} else if statErr != nil {
		return statErr
	}
	if info.IsDir() {
		return errors.New("local resource path points to a directory")
	}
	if err := s.ensureSafeExistingPath(path); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func (s *FileStore) ensureSafeParent(directory string) error {
	if err := os.MkdirAll(s.root, 0o750); err != nil {
		return fmt.Errorf("create local resource root: %w", err)
	}
	probe := directory
	for {
		if _, err := os.Lstat(probe); err == nil {
			return s.ensureSafeExistingPath(probe)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return errors.New("local resource parent does not exist")
		}
		probe = parent
	}
}

func (s *FileStore) ensureSafeExistingPath(path string) error {
	resolvedRoot, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return fmt.Errorf("resolve local resource root: %w", err)
	}
	resolvedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedPath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("local resource path escapes its root")
	}
	return nil
}

func (s *FileStore) path(objectKey string) (string, error) {
	if s == nil || strings.TrimSpace(s.root) == "" {
		return "", errors.New("local resource store is not initialized")
	}
	clean, err := localizedObjectKey(objectKey)
	if err != nil {
		return "", err
	}
	return filepath.Join(s.root, clean), nil
}

// localizedObjectKey accepts slash-separated relative keys and rejects
// traversal, rooted, volume-relative, and absolute paths on every OS.
// filepath.IsAbs is not enough on Windows: "/absolute" and "\absolute" are
// rooted but not volume-qualified, so IsAbs is false there.
func localizedObjectKey(objectKey string) (string, error) {
	trimmed := strings.TrimSpace(objectKey)
	native := filepath.FromSlash(trimmed)
	clean := filepath.Clean(native)
	if trimmed == "" || clean == "." || clean == ".." || !filepath.IsLocal(native) || !filepath.IsLocal(clean) {
		return "", errors.New("local resource object key is invalid")
	}
	return clean, nil
}
