package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/workspace"
)

// AuthUser is retained as a response-shape compatibility type. Local mode has
// no session or external identity provider.
type AuthUser struct {
	model.User
	AvatarURL        string `json:"avatarUrl,omitempty"`
	IdentityProvider string `json:"identityProvider,omitempty"`
	IdentityID       string `json:"identityId,omitempty"`
	IdentityUsername string `json:"identityUsername,omitempty"`
}

func (s *Service) WorkspaceIdentity() *workspace.Service {
	if s == nil || s.repo == nil {
		return workspace.NewService(nil)
	}
	return workspace.NewService(s.repo)
}

func (s *Service) LocalWorkspaceOwner() (*model.User, error) {
	return s.WorkspaceIdentity().LocalWorkspaceOwner()
}

func (s *Service) WorkspaceOwner(id string) (*model.User, error) {
	return s.WorkspaceIdentity().WorkspaceOwner(id)
}

func (s *Service) PublicAuthUser(user *model.User) (AuthUser, error) {
	if user == nil {
		return AuthUser{}, Unauthorized("本地工作区尚未初始化")
	}
	return AuthUser{User: *user}, nil
}
