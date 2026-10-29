package bootstrap

import (
	"os/exec"
	"strings"
	"testing"
)

func TestDesktopDependencyGraphDoesNotContainServiceAliasPackage(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./cmd/desktop")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list desktop dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/service" {
			t.Fatal("desktop dependency graph still contains the service alias package")
		}
	}
}

func TestTaskDomainDoesNotDependOnApplicationService(t *testing.T) {
	assertDomainDoesNotImportApp(t, "./internal/task")
}

func TestTextReplayDomainDoesNotDependOnApplicationService(t *testing.T) {
	assertDomainDoesNotImportApp(t, "./internal/textreplay")
}

func TestEditingDomainDoesNotDependOnApplicationService(t *testing.T) {
	assertDomainDoesNotImportApp(t, "./internal/editing")
}

func TestRefactoredDomainsDoNotDependOnApplicationService(t *testing.T) {
	for _, name := range []string{
		"generation", "plugins", "modelcatalog", "operations", "asset", "canvas",
		"creation", "taskruntime", "taskdelivery", "taskbinding", "agentops",
		"assistantruntime", "assistantturns", "playback", "depthcapture", "transcription",
		"workspace", "provider/workflow",
	} {
		t.Run(name, func(t *testing.T) {
			assertDomainDoesNotImportApp(t, "./internal/"+name)
		})
	}
}

func assertDomainDoesNotImportApp(t *testing.T, pkg string) {
	t.Helper()
	command := exec.Command("go", "list", "-deps", pkg)
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list %s dependencies: %v", pkg, err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatalf("%s still depends on the application service kernel", pkg)
		}
	}
}

func TestProjectDomainDoesNotDependOnApplicationService(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./internal/project")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list project dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatal("project domain still depends on the application service kernel")
		}
	}
}

func TestConversationDomainDoesNotDependOnApplicationService(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./internal/conversation")
	command.Dir = "../.."
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

func TestEagleDomainDoesNotDependOnApplicationService(t *testing.T) {
	assertDomainDoesNotImportApp(t, "./internal/eagle")
}

func TestDiagnosticsDomainDoesNotDependOnApplicationService(t *testing.T) {
	assertDomainDoesNotImportApp(t, "./internal/diagnostics")
}

func TestAppearanceDomainDoesNotDependOnApplicationService(t *testing.T) {
	assertDomainDoesNotImportApp(t, "./internal/appearance")
}

func TestModelCatalogDomainDoesNotDependOnApplicationService(t *testing.T) {
	assertDomainDoesNotImportApp(t, "./internal/modelcatalog")
}

func TestPluginsDomainDoesNotDependOnApplicationService(t *testing.T) {
	assertDomainDoesNotImportApp(t, "./internal/plugins")
}

func TestLocalAppDoesNotDependOnApplicationService(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./internal/localapp")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list localapp dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatal("local composition root still depends on the application service kernel")
		}
	}
}
