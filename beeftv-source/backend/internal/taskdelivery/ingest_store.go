package taskdelivery

import (
	"bytes"
	"io"
	"strings"

	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
)

type assetInlineStore struct {
	assets *asset.Service
}

func NewAssetInlineStore(assets *asset.Service) InlineStore {
	return assetInlineStore{assets: assets}
}

func (s assetInlineStore) PersistInline(userID string, artifact InlineArtifact) (*model.Resource, error) {
	if s.assets == nil {
		return nil, asset.ResourceMissing()
	}
	data, err := readInlineBytes(artifact)
	if err != nil {
		return nil, err
	}
	if !artifact.EnforceQuota {
		resource, _, err := s.assets.Store(userID, artifact.Kind, artifact.FileName, artifact.MimeType, artifact.Size, artifact.Width, artifact.Height, artifact.DurationMs, bytes.NewReader(data), nil)
		return resource, err
	}
	if strings.TrimSpace(artifact.Identity) == "" {
		return s.assets.StoreGenerated(userID, artifact.Kind, artifact.FileName, artifact.MimeType, artifact.Size, artifact.Width, artifact.Height, artifact.DurationMs, bytes.NewReader(data))
	}
	return s.assets.RecoverOwned(userID, artifact.Identity, func() (asset.RecoveredArtifact, error) {
		return asset.RecoveredArtifact{
			Kind:       artifact.Kind,
			FileName:   artifact.FileName,
			MimeType:   artifact.MimeType,
			Size:       artifact.Size,
			Width:      artifact.Width,
			Height:     artifact.Height,
			DurationMs: artifact.DurationMs,
			Body:       bytes.NewReader(data),
		}, nil
	})
}

func readInlineBytes(artifact InlineArtifact) ([]byte, error) {
	if artifact.Body == nil {
		return nil, asset.MissingUpload()
	}
	if artifact.Size < 0 {
		return nil, asset.MissingUpload()
	}
	data, err := io.ReadAll(io.LimitReader(artifact.Body, artifact.Size+1))
	if err != nil {
		return nil, err
	}
	if artifact.Size > 0 && int64(len(data)) != artifact.Size {
		return nil, asset.MissingUpload()
	}
	return data, nil
}
