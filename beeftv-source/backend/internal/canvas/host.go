package canvas

import (
	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Host 由组合根注入，避免 canvas → service 回环。
type Host interface {
	EncryptSecret(value string) (string, error)
	DecryptSecret(value string) (string, error)
	OpenResourceRange(userID string, resource *model.Resource, rangeHeader string) (*assets.ResourceStream, error)
	PrepareResourceDelivery(userID string, resource *model.Resource, options assets.ResourceDeliveryOptions) (*assets.ResourceDelivery, error)
	WithStorageLock(fn func() error) error
	StructuredQuota(userID, kind string, creating bool, deltaBytes int64) error
	StructuredBatchQuota(userID, kind string, createdCount int, deltaBytes int64) error
	AdmitStructuredQuota(usage repository.UserStorageUsage, kind string, creating bool, deltaBytes int64) error
	StructuredReplacementQuota(userID, kind string, count int, bytes int64) error
	DeleteUserAssetWithResources(userID, assetID string, expectedStatus ...string) error
	RecordActivity(userID, event string, count int)
}

type nopHost struct{}

func (nopHost) EncryptSecret(value string) (string, error) { return value, nil }
func (nopHost) DecryptSecret(value string) (string, error) { return value, nil }
func (nopHost) OpenResourceRange(string, *model.Resource, string) (*assets.ResourceStream, error) {
	return nil, nil
}
func (nopHost) PrepareResourceDelivery(string, *model.Resource, assets.ResourceDeliveryOptions) (*assets.ResourceDelivery, error) {
	return nil, nil
}
func (nopHost) WithStorageLock(fn func() error) error {
	if fn == nil {
		return nil
	}
	return fn()
}
func (nopHost) StructuredQuota(string, string, bool, int64) error     { return nil }
func (nopHost) StructuredBatchQuota(string, string, int, int64) error { return nil }
func (nopHost) AdmitStructuredQuota(repository.UserStorageUsage, string, bool, int64) error {
	return nil
}
func (nopHost) StructuredReplacementQuota(string, string, int, int64) error  { return nil }
func (nopHost) DeleteUserAssetWithResources(string, string, ...string) error { return nil }
func (nopHost) RecordActivity(string, string, int)                           {}

type Service struct {
	repo    *repository.Repository
	host    Host
	library *asset.Library
}

type canvasLibraryHost struct {
	service *Service
}

func (h *canvasLibraryHost) WithStorageLock(fn func() error) error {
	return h.service.host.WithStorageLock(fn)
}
func (h *canvasLibraryHost) StructuredBatchQuota(userID, kind string, createdCount int, deltaBytes int64) error {
	return h.service.host.StructuredBatchQuota(userID, kind, createdCount, deltaBytes)
}
func (h *canvasLibraryHost) StructuredReplacementQuota(userID, kind string, count int, bytes int64) error {
	return h.service.host.StructuredReplacementQuota(userID, kind, count, bytes)
}
func (h *canvasLibraryHost) DeleteUserAssetWithResources(userID, assetID string, expectedStatus ...string) error {
	return h.service.host.DeleteUserAssetWithResources(userID, assetID, expectedStatus...)
}
func (h *canvasLibraryHost) RecordActivity(userID, event string, count int) {
	h.service.host.RecordActivity(userID, event, count)
}

var _ asset.Host = (*canvasLibraryHost)(nil)

// WithHost 返回使用指定 host 的服务副本；host 提供配额、存储锁与资源访问等真实校验。
func (s *Service) WithHost(host Host) *Service {
	if s == nil {
		return New(nil, host)
	}
	return New(s.repo, host)
}

// WithRepository 返回绑定到指定仓储（可为事务）的服务副本。
func (s *Service) WithRepository(repo *repository.Repository) *Service {
	if s == nil {
		return New(repo, nil)
	}
	next := New(repo, s.host)
	if s.library != nil {
		next.library = s.library.WithRepository(repo).WithHost(&canvasLibraryHost{service: next})
	}
	return next
}

func New(repo *repository.Repository, host Host) *Service {
	if host == nil {
		host = nopHost{}
	}
	s := &Service{repo: repo, host: host}
	s.library = asset.NewLibrary(repo, &canvasLibraryHost{service: s})
	return s
}

func (s *Service) Library() *asset.Library {
	if s == nil {
		return asset.NewLibrary(nil, nil)
	}
	if s.library != nil {
		return s.library
	}
	return asset.NewLibrary(s.repo, &canvasLibraryHost{service: s})
}
