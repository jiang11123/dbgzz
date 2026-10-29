package generation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOfficialPluginPackageCandidatesPreferExecutableSibling(t *testing.T) {
	exe := filepath.Join(string(filepath.Separator), "opt", "BeefTV", "BeefTV.exe")
	cwd := filepath.Join(string(filepath.Separator), "Users", "someone", "Downloads")
	candidates := OfficialPluginPackageCandidates(exe, cwd)
	if candidates[0] != "/app/plugin-packages" {
		t.Fatalf("first candidate = %q, want container path", candidates[0])
	}
	exeDir := filepath.Dir(exe)
	sibling := filepath.Join(exeDir, "plugin-packages")
	macResources := filepath.Join(exeDir, "..", "Resources", "plugin-packages")
	cwdPlugins := filepath.Join(cwd, "plugin-packages")
	if indexOfPath(candidates, sibling) < 0 {
		t.Fatalf("missing Windows/Linux sibling %q in %#v", sibling, candidates)
	}
	if indexOfPath(candidates, macResources) < 0 {
		t.Fatalf("missing macOS Resources %q in %#v", macResources, candidates)
	}
	if indexOfPath(candidates, sibling) > indexOfPath(candidates, macResources) {
		t.Fatalf("executable sibling must be searched before macOS Resources: %#v", candidates)
	}
	if indexOfPath(candidates, macResources) > indexOfPath(candidates, cwdPlugins) {
		t.Fatalf("executable-relative paths must be searched before cwd: %#v", candidates)
	}
}

func TestResolveOfficialPluginPackageDirUsesExecutableSiblingWithoutRepoCwd(t *testing.T) {
	root := t.TempDir()
	exeDir := filepath.Join(root, "release")
	sibling := filepath.Join(exeDir, "plugin-packages")
	cwd := filepath.Join(root, "unrelated-cwd")
	mustMkdir(t, sibling)
	mustMkdir(t, cwd)

	got, err := resolveOfficialPluginPackageDir(OfficialPluginPackageCandidates(filepath.Join(exeDir, "BeefTV.exe"), cwd))
	if err != nil {
		t.Fatal(err)
	}
	if got != sibling {
		t.Fatalf("resolveOfficialPluginPackageDir() = %q, want executable sibling %q", got, sibling)
	}
}

func TestResolveOfficialPluginPackageDirUsesMacResourcesWhenSiblingMissing(t *testing.T) {
	root := t.TempDir()
	exeDir := filepath.Join(root, "BeefTV.app", "Contents", "MacOS")
	resources := filepath.Join(exeDir, "..", "Resources", "plugin-packages")
	cwd := filepath.Join(root, "unrelated-cwd")
	mustMkdir(t, exeDir)
	mustMkdir(t, resources)
	mustMkdir(t, cwd)

	got, err := resolveOfficialPluginPackageDir(OfficialPluginPackageCandidates(filepath.Join(exeDir, "BeefTV"), cwd))
	if err != nil {
		t.Fatal(err)
	}
	if got != resources {
		t.Fatalf("resolveOfficialPluginPackageDir() = %q, want macOS Resources %q", got, resources)
	}
}

func TestOfficialPluginPackageDirHonorsConfiguredDirectory(t *testing.T) {
	configured := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", configured)
	got, err := OfficialPluginPackageDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != configured {
		t.Fatalf("OfficialPluginPackageDir() = %q, want %q", got, configured)
	}
}

func TestOfficialPluginPackageDirRejectsConfiguredFile(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "not-a-dir")
	if err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", file.Name())
	_, err = OfficialPluginPackageDir()
	if err == nil || !strings.Contains(err.Error(), "CANVAS_OFFICIAL_PLUGIN_DIR") {
		t.Fatalf("expected configured-directory error, got %v", err)
	}
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func indexOfPath(values []string, want string) int {
	for index, value := range values {
		if value == want {
			return index
		}
	}
	return -1
}
