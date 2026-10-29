package desktopupdate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAgentHostRejectsMissingStaticModules(t *testing.T) {
	for _, name := range []string{"canvas-turn.mjs", "request-budget.mjs"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			if err := writeAgentLayout(root, "runtime/node.exe", "fixture"); err != nil {
				t.Fatal(err)
			}
			if err := validateAgentHost(root, "runtime/node.exe", false); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(filepath.Join(root, name)); err != nil {
				t.Fatal(err)
			}
			if err := validateAgentHost(root, "runtime/node.exe", false); err == nil {
				t.Fatal("incomplete host must be rejected before installation")
			}
		})
	}
}
