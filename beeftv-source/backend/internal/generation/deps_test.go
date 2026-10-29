package generation

import (
	"os/exec"
	"strings"
	"testing"
)

func TestGenerationDomainDoesNotImportApp(t *testing.T) {
	assertGenerationForbiddenDeps(t, map[string]string{
		"infinite-canvas/backend/internal/app": "internal/app",
	})
}

func TestGenerationDomainDoesNotDependOnCreationOrCanvas(t *testing.T) {
	assertGenerationForbiddenDeps(t, map[string]string{
		"infinite-canvas/backend/internal/creation": "creation",
		"infinite-canvas/backend/internal/canvas":   "canvas document writes",
	})
}

func assertGenerationForbiddenDeps(t *testing.T, forbidden map[string]string) {
	t.Helper()
	command := exec.Command("go", "list", "-deps", ".")
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list generation dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if label, ok := forbidden[dependency]; ok {
			t.Fatalf("generation domain still depends on %s", label)
		}
	}
}
