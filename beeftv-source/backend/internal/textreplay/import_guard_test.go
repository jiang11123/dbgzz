package textreplay

import (
	"os/exec"
	"strings"
	"testing"
)

func TestTextReplayDomainDoesNotDependOnApplicationService(t *testing.T) {
	command := exec.Command("go", "list", "-deps", ".")
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list textreplay dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatal("textreplay domain still depends on the application service kernel")
		}
	}
}
