package conversation_test

import (
	"os/exec"
	"strings"
	"testing"
)

func TestConversationDomainDoesNotDependOnApplicationService(t *testing.T) {
	command := exec.Command("go", "list", "-deps", ".")
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list conversation dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatal("conversation domain still depends on the application service kernel")
		}
	}
}
