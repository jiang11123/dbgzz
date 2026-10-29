package platform

import (
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const TaskWorkerConcurrency = 3

// Host 由组合根注入，避免 platform → app 回环。
type Host interface {
	RequireAdmin(user *model.User) error
	AppendAudit(actor *model.User, action, targetType, targetID, summary string, metadata any) error
	ChannelConcurrencyLimit(channelID string) (int, error)
}

type nopHost struct{}

func (nopHost) RequireAdmin(*model.User) error { return nil }
func (nopHost) AppendAudit(*model.User, string, string, string, string, any) error {
	return nil
}
func (nopHost) ChannelConcurrencyLimit(string) (int, error) {
	return 0, nil
}

type Service struct {
	repo             *repository.Repository
	host             Host
	Coordinator      *Coordinator
	concurrencyCache *BoundedReadCache[string, RuntimeTaskPolicy]
	localMode        bool
}

func New(repo *repository.Repository, coordinator *Coordinator, host Host) *Service {
	return newService(repo, coordinator, host, false)
}

// NewLocal creates the platform domain for the desktop profile. Local mode
// uses an in-memory self-use policy and must not depend on hosted runtime
// policy rows or their administrative controls.
func NewLocal(repo *repository.Repository, coordinator *Coordinator, host Host) *Service {
	return newService(repo, coordinator, host, true)
}

func newService(repo *repository.Repository, coordinator *Coordinator, host Host, localMode bool) *Service {
	if host == nil {
		host = nopHost{}
	}
	return &Service{
		repo:             repo,
		host:             host,
		Coordinator:      coordinator,
		concurrencyCache: NewBoundedReadCache[string, RuntimeTaskPolicy](1, 1024, 1, 2*time.Second),
		localMode:        localMode,
	}
}

func (s *Service) requireAdmin(user *model.User) error {
	if s == nil || s.host == nil {
		return kernel.Unauthorized("请先登录")
	}
	return s.host.RequireAdmin(user)
}

func (s *Service) appendAdminAudit(actor *model.User, action, targetType, targetID, summary string, metadata any) error {
	if s == nil || s.host == nil {
		return nil
	}
	return s.host.AppendAudit(actor, action, targetType, targetID, summary, metadata)
}
