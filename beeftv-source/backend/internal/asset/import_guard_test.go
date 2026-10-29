package asset

import (
	"os/exec"
	"strings"
	"testing"
)

func TestAssetDoesNotDependOnApp(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./internal/asset")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list asset dependencies: %v\n%s", err, output)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatal("asset still depends on the application service kernel")
		}
	}
}
