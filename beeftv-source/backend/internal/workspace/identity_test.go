package workspace

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

type fakeWorkspaceRepo struct {
	byID    map[string]*model.Workspace
	def     *model.Workspace
	loadErr error
}

func (f fakeWorkspaceRepo) Workspace(id string) (*model.Workspace, error) {
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	value := f.byID[id]
	if value == nil {
		return nil, errors.New("workspace not found")
	}
	return value, nil
}

func (f fakeWorkspaceRepo) DefaultWorkspace() (*model.Workspace, error) {
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	return f.def, nil
}

func TestWorkspaceServiceProjectsExistingLocalPrincipal(t *testing.T) {
	now := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	record := &model.Workspace{ID: "ws-1", Name: "本地工作区", CreatedAt: now, UpdatedAt: now}
	svc := NewService(fakeWorkspaceRepo{
		byID: map[string]*model.Workspace{"ws-1": record},
		def:  record,
	})

	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	if owner.ID != "ws-1" || owner.Username != "local" || owner.DisplayName != "本地工作区" {
		t.Fatalf("owner identity = %#v", owner)
	}
	if owner.Role != model.UserRoleAdmin || owner.Status != model.UserStatusActive {
		t.Fatalf("owner role/status = %s/%s", owner.Role, owner.Status)
	}

	named, err := svc.WorkspaceOwner("ws-1")
	if err != nil {
		t.Fatal(err)
	}
	if named.ID != owner.ID || named.Username != "local" {
		t.Fatalf("named owner = %#v", named)
	}
}

func TestWorkspaceServiceUnavailableWithoutRepository(t *testing.T) {
	var svc *Service
	_, err := svc.LocalWorkspaceOwner()
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Status != 401 {
		t.Fatalf("nil service error = %v", err)
	}
	_, err = NewService(nil).WorkspaceOwner("ws-1")
	if !errors.As(err, &appErr) || appErr.Status != 401 {
		t.Fatalf("nil repo error = %v", err)
	}
	_, err = NewService(fakeWorkspaceRepo{}).LocalWorkspaceOwner()
	if !errors.As(err, &appErr) || appErr.Status != 401 {
		t.Fatalf("nil workspace error = %v", err)
	}
}

func TestLocalPrincipalJSONKeepsExternalUserShape(t *testing.T) {
	principal := LocalPrincipal(&model.Workspace{ID: "ws-1", Name: "本地工作区"})
	body, err := json.Marshal(principal)
	if err != nil {
		t.Fatal(err)
	}
	var view map[string]any
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatal(err)
	}
	if view["id"] != "ws-1" || view["username"] != "local" || view["role"] != "admin" || view["status"] != "active" {
		t.Fatalf("principal json = %s", body)
	}
}
