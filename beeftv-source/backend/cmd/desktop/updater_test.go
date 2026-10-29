package main

import (
	"reflect"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/desktopupdate"
)

func TestUpdateStatusKeepsVersionWhenDisabled(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	state := app.UpdateStatus()
	if state.Status != desktopupdate.StatusDisabled {
		t.Fatalf("status = %q", state.Status)
	}
	if strings.TrimSpace(state.CurrentVersion) == "" {
		t.Fatal("currentVersion must stay visible when updates are disabled")
	}
	if _, err := app.CheckForUpdate(); err == nil {
		t.Fatal("disabled check should fail")
	}
}

func TestDesktopAppDoesNotEmbedUpdater(t *testing.T) {
	typ := reflect.TypeOf(DesktopApp{})
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if strings.Contains(field.Type.String(), "desktopupdate") {
			t.Fatalf("bound struct field %s exposes updater internals", field.Name)
		}
	}
}

func TestInstallUpdateRequiresReadyWindow(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if err := app.InstallUpdate(); err == nil {
		t.Fatal("expected install to fail before the window is ready")
	}
}

func TestUpdateCleanupRequiresReadyWorkspace(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if err := app.ConfirmUpdateStartup(); err == nil {
		t.Fatal("startup cleanup must wait for the workspace")
	}
}
