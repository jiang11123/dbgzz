package main

import (
	"context"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"infinite-canvas/backend/internal/referencestorage"
)

func (a *DesktopApp) ReferenceStorageSettings() (referencestorage.PublicConfig, error) {
	a.mu.RLock()
	dir := a.dataDir
	a.mu.RUnlock()
	config, err := referencestorage.Load(dir)
	return config.Public(), err
}

func (a *DesktopApp) SaveReferenceStorage(config referencestorage.Config) (referencestorage.PublicConfig, error) {
	if !a.migrationMu.TryLock() {
		return referencestorage.PublicConfig{}, errors.New("工作区正在迁移，请稍后保存")
	}
	defer a.migrationMu.Unlock()
	a.mu.RLock()
	dir := a.dataDir
	a.mu.RUnlock()
	return referencestorage.Save(dir, config)
}

func (a *DesktopApp) UploadReferenceMedia(ids []string) (map[string]string, error) {
	if len(ids) == 0 || len(ids) > 20 {
		return nil, errors.New("参考素材数量无效")
	}
	if !a.migrationMu.TryLock() {
		return nil, errors.New("工作区正在迁移或上传，请稍后重试")
	}
	defer a.migrationMu.Unlock()
	a.mu.RLock()
	dir := a.dataDir
	runtime := a.runtime()
	closing := a.closing
	a.mu.RUnlock()
	if runtime == nil || closing {
		return nil, errors.New("工作区尚未就绪")
	}
	config, err := referencestorage.Load(dir)
	if err != nil {
		return nil, err
	}
	temp := filepath.Join(dir, "cache", "tmp")
	if err = os.MkdirAll(temp, 0700); err != nil {
		return nil, err
	}
	staging, err := os.MkdirTemp(temp, "reference-upload-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(staging)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	a.mu.Lock()
	a.migrationCancel = cancel
	if a.closing {
		cancel()
	}
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.migrationCancel = nil; a.mu.Unlock() }()
	links := map[string]string{}
	defer func() { a.mu.Lock(); a.referenceUploadProgress = model.TaskReferenceProgress{}; a.mu.Unlock() }()
	for index, id := range ids {
		if _, exists := links[id]; exists {
			continue
		}
		// CopyOwnedResourceTo checks ownership; arbitrary paths never reach the uploader.
		started := time.Now().UnixMilli()
		label := "参考素材 " + strconv.Itoa(index+1)
		a.mu.Lock()
		a.referenceUploadProgress = model.TaskReferenceProgress{Label: label, Phase: "preparing", StartedAt: started, UpdatedAt: started}
		a.mu.Unlock()
		path := filepath.Join(staging, strconv.Itoa(index))
		if err = runtime.CopyOwnedResourceTo(id, path); err != nil {
			return nil, fmt.Errorf("参考素材 %d 读取失败：%w", index+1, err)
		}
		var rate outbound.ProgressRate
		link, err := referencestorage.Upload(ctx, config, path, func(loaded, total int64, phase string) {
			a.mu.Lock()
			defer a.mu.Unlock()
			if ctx.Err() != nil || a.referenceUploadProgress.Label != label || a.referenceUploadProgress.StartedAt != started {
				return
			}
			now := time.Now()
			rate.Observe(now, loaded)
			a.referenceUploadProgress.LoadedBytes, a.referenceUploadProgress.TotalBytes = loaded, total
			a.referenceUploadProgress.Phase, a.referenceUploadProgress.UpdatedAt = phase, now.UnixMilli()
			a.referenceUploadProgress.BytesPerSecond = rate.Rate(now, loaded)
		})
		if err != nil {
			return nil, fmt.Errorf("参考素材 %d 上传失败：%w", index+1, err)
		}
		links[id] = link
	}
	return links, nil
}

func (a *DesktopApp) ReferenceUploadStatus() model.TaskReferenceProgress {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.referenceUploadProgress
}

func (a *DesktopApp) TestReferenceStorage() error {
	if !a.migrationMu.TryLock() {
		return errors.New("工作区正在迁移或上传，请稍后测试")
	}
	defer a.migrationMu.Unlock()
	a.mu.RLock()
	dir, closing := a.dataDir, a.closing
	a.mu.RUnlock()
	if closing {
		return errors.New("工作区正在关闭")
	}
	config, err := referencestorage.Load(dir)
	if err != nil {
		return err
	}
	temp := filepath.Join(dir, "cache", "tmp")
	if err := os.MkdirAll(temp, 0700); err != nil {
		return errors.New("无法创建存储测试文件，请检查本地磁盘")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	a.mu.Lock()
	a.migrationCancel = cancel
	if a.closing {
		cancel()
	}
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.migrationCancel = nil; a.mu.Unlock() }()
	return referencestorage.Check(ctx, config, temp)
}
