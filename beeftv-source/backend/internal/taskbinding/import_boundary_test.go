package taskbinding

import (
	"os/exec"
	"strings"
	"testing"
)

func TestTaskBindingDoesNotDependOnAppOrOperations(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./internal/taskbinding")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list taskbinding dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatal("taskbinding still depends on the application service kernel")
		}
		if dependency == "infinite-canvas/backend/internal/operations" {
			t.Fatal("taskbinding still depends on the operations registry")
		}
		if dependency == "infinite-canvas/backend/internal/canvas" {
			t.Fatal("taskbinding still depends on canvas document writes")
		}
	}
}
