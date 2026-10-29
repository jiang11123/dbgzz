package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

// Archive bytes use the existing atomic FileStore and the operation-bound
// resource repository, so no second SQLite writer is opened inside the receipt.
func (s *operationSession) ExportCanvasProjectArchive(ctx context.Context, userID, operationID string, document json.RawMessage) (*model.Resource, error) {
	if s.tx == nil {
		return nil, operations.PreconditionFailed("export_transaction_required", "工程导出需要业务事务", nil)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	key := "project-export:" + operationID
	if existing, err := s.repo.ResourceByUploadKey(userID, key); err == nil {
		if existing.Status == model.ResourceStatusReady {
			return existing, nil
		}
		return nil, resourceUploadInProgress()
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	directory := filepath.Join(s.service.dataDir, "tmp")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	file, err := os.CreateTemp(directory, "project-export-*.zip")
	if err != nil {
		return nil, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err = canvas.WriteProjectArchive(ctx, file, document, projectArchiveSources{s: s, userID: userID}); err != nil {
		return nil, operations.PreconditionFailed("project_export_source_unavailable", err.Error(), nil)
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	policy, err := s.service.runtimePolicyWithRepo(s.repo)
	if err != nil {
		return nil, err
	}
	if info.Size() <= 0 || info.Size() > megabytes(policy.Resource.GeneratedFileMB) {
		return nil, BadAuthRequest(fmt.Sprintf("工程包不能超过 %dMB", policy.Resource.GeneratedFileMB))
	}
	stored, err := s.repo.UserStoredFileBytes(userID)
	if err != nil {
		return nil, err
	}
	if stored+info.Size() >= gigabytes(policy.Resource.StoredFileGB) {
		return nil, QuotaExceeded("工程包超过工作区存储额度")
	}
	day := time.Now().UTC().Format("2006-01-02")
	if err = s.repo.ReserveIdentifiedDailyUpload(userID, day, key, info.Size(), megabytes(policy.Resource.DailyUploadMB)); err != nil {
		if errors.Is(err, repository.ErrDailyUploadLimitExceeded) {
			return nil, QuotaExceeded("工程包超过今日保存额度")
		}
		return nil, err
	}
	if _, err = file.Seek(0, 0); err != nil {
		return nil, err
	}
	resources := localasset.NewService(localasset.Dependencies{Repository: localasset.NewRepository(s.repo), Blobs: localasset.NewFileStore(s.service.dataDir), LocalStorage: true})
	resource, _, err := resources.Store(userID, "file", "BeefTV-project.zip", "application/zip", info.Size(), 0, 0, 0, file, &key)
	return resource, err
}

type projectArchiveSources struct {
	s      *operationSession
	userID string
}

func (o projectArchiveSources) OpenArchiveMedia(ctx context.Context, resourceID string) (canvas.ArchiveMedia, error) {
	if err := ctx.Err(); err != nil {
		return canvas.ArchiveMedia{}, err
	}
	resource, err := o.s.OwnedReadyResource(o.userID, resourceID)
	if err != nil {
		return canvas.ArchiveMedia{}, err
	}
	resources := localasset.NewService(localasset.Dependencies{Repository: localasset.NewRepository(o.s.repo), Blobs: localasset.NewFileStore(o.s.service.dataDir), LocalStorage: true})
	_, body, err := resources.Open(o.userID, resourceID)
	if err != nil {
		return canvas.ArchiveMedia{}, err
	}
	return canvas.ArchiveMedia{Body: body, MimeType: resource.MimeType, Bytes: resource.Size}, nil
}

var _ operations.CanvasProjectExporter = (*operationSession)(nil)
