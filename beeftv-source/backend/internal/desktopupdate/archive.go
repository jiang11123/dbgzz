package desktopupdate

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type extractLimits struct {
	MaxFiles      int
	MaxEntryBytes uint64
	MaxTotalBytes uint64
}

func defaultExtractLimits() extractLimits {
	return extractLimits{MaxFiles: maxZipFiles, MaxEntryBytes: maxZipEntry, MaxTotalBytes: maxZipTotal}
}

func sanitizeZipName(name string) (string, bool, error) {
	name = strings.TrimSpace(name)
	if name == "" || strings.ContainsRune(name, 0) {
		return "", false, ErrInvalidArchive
	}
	if strings.Contains(name, "\\") {
		return "", false, ErrInvalidArchive
	}
	if strings.HasPrefix(name, "/") || strings.HasPrefix(name, "//") {
		return "", false, ErrInvalidArchive
	}
	if len(name) >= 2 && name[1] == ':' {
		return "", false, ErrInvalidArchive
	}
	if strings.HasPrefix(name, "\\\\") {
		return "", false, ErrInvalidArchive
	}
	dirEntry := strings.HasSuffix(name, "/")
	trimmed := strings.TrimSuffix(name, "/")
	cleaned := path.Clean(trimmed)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", false, ErrInvalidArchive
	}
	if cleaned != trimmed {
		return "", false, ErrInvalidArchive
	}
	for _, part := range strings.Split(cleaned, "/") {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, ":<>\"|?*") || strings.TrimRight(part, ". ") != part {
			return "", false, ErrInvalidArchive
		}
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || (len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9') {
			return "", false, ErrInvalidArchive
		}
	}
	return cleaned, dirEntry, nil
}

func isZipSymlink(file *zip.File) bool {
	if file.Mode()&os.ModeSymlink != 0 {
		return true
	}
	// Unix spec: symlink is type 0120000 in the upper bits of ExternalAttrs.
	if file.CreatorVersion>>8 == 3 {
		unixMode := file.ExternalAttrs >> 16
		if unixMode&0xF000 == 0xA000 {
			return true
		}
	}
	return false
}

func extractSecureZip(zipPath, dest string, limits extractLimits) error {
	return extractSecureZipWithProgress(context.Background(), zipPath, dest, limits, nil)
}

// contextReader also checks cancellation while processing a large entry.
type contextReader struct {
	ctx context.Context
	io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}

func extractSecureZipWithProgress(ctx context.Context, zipPath, dest string, limits extractLimits, progress func(int, int)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return ErrInvalidArchive
	}
	defer reader.Close()
	if len(reader.File) == 0 {
		return ErrInvalidArchive
	}
	if limits.MaxFiles <= 0 {
		limits = defaultExtractLimits()
	}
	if len(reader.File) > limits.MaxFiles {
		return ErrInvalidArchive
	}
	if err := os.MkdirAll(dest, 0o700); err != nil {
		return err
	}
	root, err := filepath.Abs(dest)
	if err != nil {
		return err
	}
	seen := make(map[string]struct{}, len(reader.File))
	var total uint64
	type planned struct {
		file    *zip.File
		rel     string
		dirOnly bool
	}
	plan := make([]planned, 0, len(reader.File))
	totalFiles := 0
	for _, file := range reader.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, dirOnly, err := sanitizeZipName(file.Name)
		if err != nil {
			return err
		}
		if _, exists := seen[strings.ToLower(rel)]; exists {
			return fmt.Errorf("更新包包含重复路径")
		}
		seen[strings.ToLower(rel)] = struct{}{}
		if isZipSymlink(file) {
			return fmt.Errorf("更新包不能包含符号链接")
		}
		if !dirOnly && file.UncompressedSize64 > limits.MaxEntryBytes {
			return ErrInvalidArchive
		}
		if !dirOnly {
			if total+file.UncompressedSize64 < total {
				return ErrInvalidArchive
			}
			total += file.UncompressedSize64
			if total > limits.MaxTotalBytes {
				return ErrInvalidArchive
			}
		}
		full := filepath.Join(root, filepath.FromSlash(rel))
		if !withinRoot(root, full) {
			return ErrInvalidArchive
		}
		plan = append(plan, planned{file: file, rel: rel, dirOnly: dirOnly || file.FileInfo().IsDir()})
		if !plan[len(plan)-1].dirOnly {
			totalFiles++
		}
	}
	completed := 0
	if progress != nil {
		progress(0, totalFiles)
	}
	var written uint64
	for _, item := range plan {
		if err := ctx.Err(); err != nil {
			return err
		}
		full := filepath.Join(root, filepath.FromSlash(item.rel))
		if item.dirOnly {
			if err := os.MkdirAll(full, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}
		perm := item.file.Mode().Perm()
		if perm == 0 {
			perm = 0o644
		}
		perm &^= os.ModeSetuid | os.ModeSetgid | os.ModeSticky
		out, err := os.OpenFile(full, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
		if err != nil {
			return err
		}
		stream, err := item.file.Open()
		if err != nil {
			out.Close()
			return err
		}
		limit := item.file.UncompressedSize64
		if limit > limits.MaxEntryBytes {
			limit = limits.MaxEntryBytes
		}
		copied, copyErr := io.Copy(out, io.LimitReader(contextReader{ctx, stream}, int64(limit)+1))
		closeErr := stream.Close()
		syncErr := out.Sync()
		closeOutErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if syncErr != nil {
			return syncErr
		}
		if closeOutErr != nil {
			return closeOutErr
		}
		if copied != int64(item.file.UncompressedSize64) || uint64(copied) > limits.MaxEntryBytes {
			return ErrInvalidArchive
		}
		if written+uint64(copied) < written || written+uint64(copied) > limits.MaxTotalBytes {
			return ErrInvalidArchive
		}
		written += uint64(copied)
		completed++
		if progress != nil {
			progress(completed, totalFiles)
		}
	}
	return rejectExtractedSymlinks(root)
}

func withinRoot(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	if filepath.IsAbs(rel) {
		return false
	}
	return true
}

func rejectExtractedSymlinks(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("更新包不能包含符号链接")
		}
		return nil
	})
}
