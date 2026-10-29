package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunUnknownCommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := run([]string{"not-a-command"}, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "unknown command") {
		t.Fatalf("expected unknown command error, got %v", err)
	}
}

func TestRunHelp(t *testing.T) {
	var stdout bytes.Buffer
	if err := run([]string{"help"}, &stdout, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "gen-key") || !strings.Contains(stdout.String(), "BEEFTV_UPDATER_PRIVATE_KEY") {
		t.Fatalf("help missing expected text: %s", stdout.String())
	}
}

func TestValidateVersionRejectsPrereleaseAndEqual(t *testing.T) {
	var stdout bytes.Buffer
	err := run([]string{"validate-version", "--version", "v1.5.1-rc.1"}, &stdout, ioDiscard{})
	if err == nil {
		t.Fatal("expected prerelease to fail")
	}
	err = run([]string{"validate-version", "--version", "v1.5.1", "--confirm", "v1.5.2"}, &stdout, ioDiscard{})
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected confirm mismatch, got %v", err)
	}
	err = run([]string{"validate-version", "--version", "v1.5.1", "--greater-than", "v1.5.1"}, &stdout, ioDiscard{})
	if err == nil || !strings.Contains(err.Error(), "not newer") {
		t.Fatalf("expected equal version to fail, got %v", err)
	}
	err = run([]string{"validate-version", "--version", "v1.6.0", "--confirm", "v1.6.0", "--greater-than", "v1.5.1"}, &stdout, ioDiscard{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(stdout.String()) != "v1.6.0" {
		t.Fatalf("unexpected stdout %q", stdout.String())
	}
}

func TestChangelogExtractsSection(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "CHANGELOG.md")
	if err := os.WriteFile(path, []byte("# Changelog\n\n## Unreleased\n\n- pending\n\n## v1.6.0\n\n- Desktop updater.\n- Keep user data.\n\n## v1.5.1\n\n- Initial snapshot.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	if err := run([]string{"changelog", "--file", path, "--version", "v1.6.0"}, &stdout, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	got := strings.TrimSpace(stdout.String())
	if got != "- Desktop updater.\n- Keep user data." {
		t.Fatalf("unexpected notes %q", got)
	}
	if err := run([]string{"changelog", "--file", path, "--version", "v9.9.9"}, &stdout, ioDiscard{}); err == nil {
		t.Fatal("expected missing heading to fail")
	}
}

type ioDiscard struct{}

func (ioDiscard) Write(p []byte) (int, error) { return len(p), nil }
