package operations

import (
	"os/exec"
	"strings"
	"testing"
)

func TestOperationsDoesNotDependOnApp(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./internal/operations")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list operations dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatal("operations still depends on the application service kernel")
		}
		if dependency == "infinite-canvas/backend/internal/agentops" {
			t.Fatal("operations still depends on the agent auth adapter")
		}
	}
}
