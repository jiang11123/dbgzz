package playback

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func (s *Service) resourcesRoot() string {
	return filepath.Join(s.dataDir, "resources")
}

func (s *Service) playbackRoot() string {
	return filepath.Join(s.dataDir, DirName)
}

func (s *Service) sourcePath(objectKey string) (string, error) {
	return jailedPath(s.resourcesRoot(), objectKey)
}

func (s *Service) copyPath(objectKey string) (string, error) {
	return jailedPath(s.playbackRoot(), objectKey)
}

func copyObjectKey(resourceID string) (string, error) {
	id := strings.TrimSpace(resourceID)
	if id == "" {
		return "", errors.New("playback resource id is empty")
	}
	return localizedObjectKey(id + ".mp4")
}

func jailedPath(root, objectKey string) (string, error) {
	cleanRoot := strings.TrimSpace(root)
	if cleanRoot == "" {
		return "", errors.New("playback store is not initialized")
	}
	clean, err := localizedObjectKey(objectKey)
	if err != nil {
		return "", err
	}
	return filepath.Join(cleanRoot, clean), nil
}

func ensureSafeExistingPath(root, path string) error {
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("resolve playback root: %w", err)
	}
	resolvedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedPath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("playback path escapes its root")
	}
	return nil
}

func localizedObjectKey(objectKey string) (string, error) {
	trimmed := strings.TrimSpace(objectKey)
	native := filepath.FromSlash(trimmed)
	clean := filepath.Clean(native)
	if trimmed == "" || clean == "." || clean == ".." || !filepath.IsLocal(native) || !filepath.IsLocal(clean) {
		return "", errors.New("playback object key is invalid")
	}
	return clean, nil
}

func ensureDir(path string) error {
	if err := os.MkdirAll(path, 0o750); err != nil {
		return err
	}
	return nil
}
