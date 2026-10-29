//go:build windows

package assistantruntime

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Register during init, but run only after all runtime/package initialization
// has completed, through the same TestMain dispatch as the other child modes.
func init() {
	platformProcessFixtures["windows-no-console"] = runWindowsNoConsoleFixture
}

func runWindowsNoConsoleFixture() int {
	fmt.Fprintln(os.Stderr, "fixture checking native console state")
	kernel := syscall.NewLazyDLL("kernel32.dll")
	window, _, _ := kernel.NewProc("GetConsoleWindow").Call()
	codePage, _, _ := kernel.NewProc("GetConsoleCP").Call()
	fmt.Fprintf(os.Stderr, "child console state: window=%d codepage=%d\n", window, codePage)
	// The product contract is no console window, not DETACHED_PROCESS semantics.
	// CREATE_NO_WINDOW may retain a headless console (and a nonzero code page).
	// GetConsoleWindow measures the window; GetConsoleCP is diagnostic only.
	// https://learn.microsoft.com/en-us/windows/console/getconsolewindow
	// https://github.com/openai/codex/issues/49760
	if window != 0 {
		fmt.Fprintln(os.Stderr, "child created a console window")
		return 2
	}
	fmt.Fprintln(os.Stdout, "host-child-stdout")
	fmt.Fprintln(os.Stderr, "host-child-stderr")
	return runHTTPFixture()
}

func TestWindowsHostHasNoConsoleAndPreservesPipes(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "host.log")
	log, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	// Production routes both diagnostic streams to the parent's stderr handle.
	originalStderr := os.Stderr
	os.Stderr = log
	t.Cleanup(func() { os.Stderr = originalStderr; _ = log.Close() })
	host := fixtureHost(t, "windows-no-console")
	// Registered after Stop cleanup so diagnostics are read while the file is open.
	t.Cleanup(func() {
		if t.Failed() {
			raw, readErr := os.ReadFile(logPath)
			t.Logf("supervised child stdout/stderr (read error: %v):\n%s", readErr, raw)
		}
	})
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", "desktop-shell-token"); err != nil {
		t.Fatalf("console-free child failed readiness: %v", err)
	}
	if health := host.Probe(context.Background()); !health.OK {
		t.Fatalf("child failed instance health proof: %#v", health)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"host-child-stdout", "host-child-stderr"} {
		if !strings.Contains(string(raw), marker) {
			t.Fatalf("missing diagnostic output %q: %s", marker, raw)
		}
	}
	// EOF must still reach the child even without a console; do not use Kill.
	host.proc.mu.Lock()
	err = host.proc.lifetimeW.Close()
	host.proc.lifetimeW = nil
	host.proc.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if !waitUntil(5*time.Second, func() bool { return !host.Running() }) {
		t.Fatal("child did not exit after lifetime pipe EOF")
	}
	if host.Endpoint() != "" {
		t.Fatal("exited child retained its endpoint")
	}
}
