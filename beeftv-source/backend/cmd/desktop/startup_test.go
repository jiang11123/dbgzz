package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/options"
	"infinite-canvas/backend/internal/runtimeinfo"
)

func TestSecondLaunchReachesWailsWhilePrimaryOwnsWorkspace(t *testing.T) {
	for _, key := range []string{"TMPDIR", "TEMP", "TMP"} {
		t.Setenv(key, os.Getenv(key))
	}
	primary := newDesktopApp(t.TempDir())
	if err := primary.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { primary.stop(context.Background()) })
	primaryOptions := desktopAppOptions(primary)
	secondary := newDesktopApp(primary.dataDir)
	link := "beeftv://skills/install?id=official-interview-outline&version=official-interview-outline-1.0.0"
	enteredWails := false
	err := runDesktopApp(secondary, func(opts *options.App) error {
		enteredWails = true
		if secondary.runtime() != nil {
			t.Fatal("secondary opened the workspace before single-instance dispatch")
		}
		if opts.SingleInstanceLock.UniqueId != primaryOptions.SingleInstanceLock.UniqueId {
			t.Fatal("same workspace did not select the primary instance")
		}
		// Wails forwards these arguments and exits the second process without
		// calling its OnStartup. Exercise our actual receiver with the real lock held.
		primaryOptions.SingleInstanceLock.OnSecondInstanceLaunch(options.SecondInstanceData{Args: []string{"--data-dir=" + primary.dataDir, link}})
		return nil
	})
	if err != nil || !enteredWails {
		t.Fatalf("second launch could not reach Wails: %v", err)
	}
	if got := primary.ConsumeSkillLink(); got != "/skills?releaseId=official-interview-outline-1.0.0&skillId=official-interview-outline" {
		t.Fatalf("primary did not receive exact-version preview: %q", got)
	}
	if secondary.runtime() != nil || secondary.ConsumeSkillLink() != "" {
		t.Fatal("second launch opened a runtime or consumed the primary's link")
	}
	if primary.runtime() == nil {
		t.Fatal("second launch stopped the primary runtime")
	}
	if _, err := os.Stat(filepath.Join(primary.dataDir, "startup-error.log")); !os.IsNotExist(err) {
		t.Fatalf("forwarding wrote a startup failure: %v", err)
	}
}

func TestSeparateWorkspaceRunsItsOwnStartup(t *testing.T) {
	for _, key := range []string{"TMPDIR", "TEMP", "TMP"} {
		t.Setenv(key, os.Getenv(key))
	}
	primary := newDesktopApp(t.TempDir())
	if err := primary.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { primary.stop(context.Background()) })
	other := newDesktopApp(t.TempDir())
	t.Cleanup(func() { other.shutdown(context.Background()) })
	if err := runDesktopApp(other, func(opts *options.App) error {
		if opts.SingleInstanceLock.UniqueId == desktopAppOptions(primary).SingleInstanceLock.UniqueId {
			t.Fatal("different data directories share the Wails instance lock")
		}
		if other.runtime() != nil {
			t.Fatal("backend opened before the Wails primary-instance decision")
		}
		opts.OnStartup(context.Background())
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := other.RuntimeConfig(); got.BaseURL == "" || got.BaseURL == primary.RuntimeConfig().BaseURL {
		t.Fatal("isolated startup did not receive its own backend")
	}
}

func TestPrimaryStartupFailureStillRecordsWorkspaceLockError(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	lock, err := runtimeinfo.LockWorkspace(app.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	err = prepareDesktopApp(app)
	if err == nil || app.runtime() != nil {
		t.Fatal("primary startup bypassed an existing workspace lock")
	}
	data, readErr := os.ReadFile(filepath.Join(app.dataDir, "startup-error.log"))
	if readErr != nil || strings.TrimSpace(string(data)) != err.Error() {
		t.Fatalf("startup failure not recorded: %q, %v", data, readErr)
	}
}
