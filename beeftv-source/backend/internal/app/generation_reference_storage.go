package app

import (
	"context"
	"errors"
	"infinite-canvas/backend/internal/generation"
	"io"
	"os"
	"path/filepath"

	"infinite-canvas/backend/internal/referencestorage"
)

type appReferenceStoragePort struct{ service *Service }

func (p appReferenceStoragePort) Enabled() (bool, error) {
	if p.service == nil || !p.service.IsLocalMode() {
		return false, nil
	}
	config, err := referencestorage.Load(p.service.dataDir)
	return config.Enabled, err
}

func (p appReferenceStoragePort) Upload(ctx context.Context, userID, resourceID string) (string, error) {
	if p.service == nil || !p.service.IsLocalMode() {
		return "", errors.New("当前工作区未启用本地素材上传")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	config, err := referencestorage.Load(p.service.dataDir)
	if err != nil {
		return "", errors.New("参考素材对象存储配置无法读取")
	}
	// OpenResource enforces ownership; callers cannot pass filesystem paths.
	_, body, err := p.service.OpenResource(userID, resourceID)
	if err != nil {
		return "", errors.New("参考素材无法读取，请检查素材是否仍在当前工作区")
	}
	defer body.Close()
	temp := filepath.Join(p.service.dataDir, "cache", "tmp")
	if err := os.MkdirAll(temp, 0700); err != nil {
		return "", errors.New("无法准备参考素材，请检查本地磁盘")
	}
	file, err := os.CreateTemp(temp, "reference-generation-*")
	if err != nil {
		return "", errors.New("无法准备参考素材，请检查本地磁盘")
	}
	defer os.Remove(file.Name())
	_, copyErr := io.Copy(file, body)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		return "", errors.New("无法保存临时参考素材，请检查本地磁盘")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return referencestorage.Upload(ctx, config, file.Name(), generation.ReferenceUploadObserver(ctx, "参考素材"))
}
