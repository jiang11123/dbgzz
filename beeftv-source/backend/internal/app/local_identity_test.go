package app

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestLocalIdentityWrappersKeepExternalUserJSON(t *testing.T) {
	dir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "identity.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), dir)
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	if owner.Username != "local" || owner.Role != model.UserRoleAdmin || owner.Status != model.UserStatusActive {
		t.Fatalf("wrapper principal = %#v", owner)
	}
	named, err := svc.WorkspaceOwner(owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	if named.ID != owner.ID {
		t.Fatalf("named owner id = %s", named.ID)
	}
	public, err := svc.PublicAuthUser(owner)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	var view map[string]any
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatal(err)
	}
	if view["username"] != "local" || view["role"] != "admin" || view["status"] != "active" {
		t.Fatalf("auth user json = %s", body)
	}
	if _, ok := view["identityProvider"]; ok {
		t.Fatalf("empty identity fields were serialized: %s", body)
	}
}

func TestLocalIdentityUnavailableWithoutRepository(t *testing.T) {
	svc := NewLocal(nil, t.TempDir())
	_, err := svc.LocalWorkspaceOwner()
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Status != 401 {
		t.Fatalf("uninitialized identity error = %v", err)
	}
	_, err = svc.PublicAuthUser(nil)
	if !errors.As(err, &appErr) || appErr.Status != 401 {
		t.Fatalf("nil public user error = %v", err)
	}
}
