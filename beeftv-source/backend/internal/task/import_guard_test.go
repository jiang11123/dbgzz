package task

import (
	"os/exec"
	"strings"
	"testing"
)

func TestTaskDomainDoesNotDependOnApplicationService(t *testing.T) {
	command := exec.Command("go", "list", "-deps", ".")
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list task dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatal("task domain still depends on the application service kernel")
		}
	}
}
