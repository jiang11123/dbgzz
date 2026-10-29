package workspace

import (
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

// Repository is the typed persistence port for local workspace identity.
// Lead can implement this with the existing SQLite repository and wire
// Service directly to localapp.WorkspacePort without LocalKernel.
type Repository interface {
	Workspace(id string) (*model.Workspace, error)
	DefaultWorkspace() (*model.Workspace, error)
}

// Service owns the local workspace principal rule. It is not a generic
// user or admin system: one installation has one workspace owner.
type Service struct {
	repo Repository
}

func NewService(repo Repository) *Service {
	return &Service{repo: repo}
}

func (s *Service) WorkspaceOwner(id string) (*model.User, error) {
	if s == nil || s.repo == nil {
		return nil, kernel.Unauthorized("本地工作区尚未初始化")
	}
	value, err := s.repo.Workspace(id)
	if err != nil {
		return nil, err
	}
	return requireLocalPrincipal(value)
}

func (s *Service) LocalWorkspaceOwner() (*model.User, error) {
	if s == nil || s.repo == nil {
		return nil, kernel.Unauthorized("本地工作区尚未初始化")
	}
	value, err := s.repo.DefaultWorkspace()
	if err != nil {
		return nil, err
	}
	return requireLocalPrincipal(value)
}

func requireLocalPrincipal(value *model.Workspace) (*model.User, error) {
	principal := LocalPrincipal(value)
	if principal == nil {
		return nil, kernel.Unauthorized("本地工作区尚未初始化")
	}
	return principal, nil
}

// LocalPrincipal is the durable local-owner projection. Role and status stay
// the existing admin/active values used by current local routes.
func LocalPrincipal(value *model.Workspace) *model.User {
	if value == nil {
		return nil
	}
	return &model.User{
		ID: value.ID, Username: "local", DisplayName: value.Name,
		Role: model.UserRoleAdmin, Status: model.UserStatusActive,
		CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt,
	}
}
