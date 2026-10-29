package eagle

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/kernel"
)

func originalPath(thumbnailPath string, itemID string, libraryPath string) (string, error) {
	realRoot, err := canonicalLibraryRoot(libraryPath)
	if err != nil {
		return "", err
	}
	if !validItemID(itemID) {
		return "", kernel.BadAuthRequest("Eagle 素材 ID 无效")
	}
	realItemDir, err := canonicalItemDir(realRoot, itemID)
	if err != nil {
		if errors.Is(err, errOutsideLibrary) {
			return "", errors.New("Eagle 素材路径不在当前素材库内")
		}
		return "", errors.New("Eagle 原文件目录不存在")
	}
	if _, err := resolveInside(realItemDir, thumbnailPath); err != nil {
		return "", errors.New("Eagle 素材路径不在当前素材库内")
	}
	base := filepath.Base(filepath.Clean(filepath.FromSlash(thumbnailPath)))
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	stem = strings.TrimSuffix(stem, "_thumbnail")
	if ext := filepath.Ext(base); ext != "" {
		if resolved, resolveErr := resolveInsideFile(realItemDir, filepath.Join(realItemDir, stem+ext)); resolveErr == nil {
			return resolved, nil
		}
	}
	entries, err := os.ReadDir(realItemDir)
	if err != nil {
		return "", errors.New("Eagle 原文件目录不存在")
	}
	candidates := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.EqualFold(entry.Name(), "metadata.json") || strings.Contains(strings.ToLower(entry.Name()), "_thumbnail") {
			continue
		}
		resolved, resolveErr := resolveInsideFile(realItemDir, filepath.Join(realItemDir, entry.Name()))
		if resolveErr != nil {
			continue
		}
		candidates = append(candidates, resolved)
	}
	if len(candidates) == 0 {
		return "", errors.New("Eagle 原始文件不存在")
	}
	sort.Strings(candidates)
	return candidates[0], nil
}

func thumbnailInsideLibrary(thumbnailPath string, itemID string, libraryPath string) (string, error) {
	realRoot, err := canonicalLibraryRoot(libraryPath)
	if err != nil {
		return "", err
	}
	if !validItemID(itemID) {
		return "", kernel.BadAuthRequest("Eagle 素材 ID 无效")
	}
	realItemDir, err := canonicalItemDir(realRoot, itemID)
	if err != nil {
		return "", errors.New("Eagle 缩略图路径不在当前素材库内")
	}
	resolved, err := resolveInsideFile(realItemDir, thumbnailPath)
	if err != nil {
		return "", errors.New("Eagle 缩略图路径不在当前素材库内")
	}
	return resolved, nil
}

var errOutsideLibrary = errors.New("eagle path outside library")

func canonicalLibraryRoot(libraryPath string) (string, error) {
	libraryPath = filepath.Clean(filepath.FromSlash(strings.TrimSpace(libraryPath)))
	if libraryPath == "." || libraryPath == "" || !filepath.IsAbs(libraryPath) {
		return "", errors.New("Eagle 素材库路径无效，无法安全读取原文件")
	}
	realRoot, err := filepath.EvalSymlinks(libraryPath)
	if err != nil {
		return "", errors.New("Eagle 素材库路径无效，无法安全读取原文件")
	}
	info, err := os.Stat(realRoot)
	if err != nil || !info.IsDir() {
		return "", errors.New("Eagle 素材库路径无效，无法安全读取原文件")
	}
	return realRoot, nil
}

func canonicalItemDir(realRoot string, itemID string) (string, error) {
	itemDir := filepath.Join(realRoot, "images", itemID+".info")
	if filepath.Clean(itemDir) != itemDir || filepath.Base(itemDir) != itemID+".info" {
		return "", kernel.BadAuthRequest("Eagle 素材 ID 无效")
	}
	realItem, err := filepath.EvalSymlinks(itemDir)
	if err != nil {
		return "", err
	}
	if !withinRoot(realRoot, realItem) || realItem == realRoot {
		return "", errOutsideLibrary
	}
	info, err := os.Stat(realItem)
	if err != nil || !info.IsDir() {
		return "", errors.New("Eagle 原文件目录不存在")
	}
	return realItem, nil
}

func resolveInsideFile(root string, candidate string) (string, error) {
	resolved, err := resolveInside(root, candidate)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil || info.IsDir() {
		return "", errOutsideLibrary
	}
	return resolved, nil
}

func resolveInside(root string, candidate string) (string, error) {
	candidate = filepath.Clean(filepath.FromSlash(candidate))
	if root == "" || candidate == "" || !filepath.IsAbs(candidate) {
		return "", errOutsideLibrary
	}
	realPath, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", errOutsideLibrary
	}
	if !withinRoot(root, realPath) || realPath == root {
		return "", errOutsideLibrary
	}
	return realPath, nil
}

func withinRoot(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return false
	}
	return true
}
