package bootstrap

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
)

// Large media stays in owned local resources; only metadata and small local
// drawing bytes cross Wails. No backup resource is created in the workspace.
type OwnedArchiveEntry struct {
	Name       string `json:"name"`
	ResourceID string `json:"resourceId,omitempty"`
	Data       []byte `json:"data,omitempty"`
}

func (r *Runtime) WriteOwnedArchiveTo(ctx context.Context, entries []OwnedArchiveEntry, dest string) error {
	if r == nil || r.service == nil {
		return errors.New("本地后端尚未就绪")
	}
	if len(entries) == 0 || len(entries) > 50_000 {
		return errors.New("导出文件数量无效")
	}
	if _, err := sanitizeSaveDestination(dest); err != nil {
		return err
	}
	owner, err := r.service.LocalWorkspaceOwner()
	if err != nil {
		return err
	}
	names := map[string]bool{}
	inlineBytes := 0
	for _, entry := range entries {
		if !safeOwnedArchiveName(entry.Name) || names[entry.Name] {
			return errors.New("导出文件名无效或重复")
		}
		names[entry.Name] = true
		if entry.ResourceID != "" && len(entry.Data) != 0 {
			return errors.New("导出文件来源无效")
		}
		if entry.ResourceID == "" && len(entry.Data) == 0 {
			return errors.New("导出文件没有内容")
		}
		inlineBytes += len(entry.Data)
		if inlineBytes > maxOwnedArtifactBytes {
			return errors.New("本地附加文件过大，请先保存素材后再导出")
		}
	}
	return writeOwnedFileWith(dest, nil, func(writer io.Writer) error {
		archive := zip.NewWriter(writer)
		var total int64
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			target, err := archive.CreateHeader(&zip.FileHeader{Name: entry.Name, Method: zip.Store})
			if err != nil {
				return err
			}
			var body io.Reader = bytes.NewReader(entry.Data)
			if entry.ResourceID != "" {
				id, err := sanitizeOwnedResourceID(entry.ResourceID)
				if err != nil {
					return err
				}
				resource, err := r.service.Resource(owner.ID, id)
				if err != nil {
					return errors.New("没有可导出的本机文件")
				}
				if resource.Size > 1<<30 || total+resource.Size > 2<<30 {
					return errors.New("导出文件超过大小限制")
				}
				source, err := openLocalOwnedResourceFile(resource, r.cfg.DataDir)
				if err != nil {
					return err
				}
				if err := rejectSameFile(source, dest); err != nil {
					source.Close()
					return err
				}
				written, copyErr := io.Copy(target, io.LimitReader(source, (1<<30)+1))
				source.Close()
				if copyErr != nil {
					return copyErr
				}
				if written == 0 || (resource.Size > 0 && written != resource.Size) {
					return errors.New("导出文件读取不完整")
				}
				total += written
				if written > 1<<30 || total > 2<<30 {
					return errors.New("导出文件超过大小限制")
				}
				continue
			}
			written, err := io.Copy(target, body)
			if err != nil {
				return err
			}
			total += written
			if total > 2<<30 {
				return errors.New("导出文件超过大小限制")
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return archive.Close()
	})
}

func safeOwnedArchiveName(name string) bool {
	if name == "" || len(name) > 1024 || strings.ContainsAny(name, "\x00\\:") || strings.HasPrefix(name, "/") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
