package depthruntime

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestEnsureInstallsRuntimeAndFallsBackForModel(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the legacy macOS runtime requires POSIX executable bits")
	}
	var runtimeArchive bytes.Buffer
	writer := zip.NewWriter(&runtimeArchive)
	entry, _ := writer.Create(".venv/bin/python")
	_, _ = entry.Write([]byte("python"))
	pythonHeader := &zip.FileHeader{Name: ".python/bin/python3.11", Method: zip.Deflate}
	pythonHeader.SetMode(0o755)
	entry, _ = writer.CreateHeader(pythonHeader)
	_, _ = entry.Write([]byte("python-binary"))
	entry, _ = writer.Create("worker/depth_capture/__init__.py")
	_, _ = entry.Write([]byte("# worker"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	model := []byte("model-weights")
	runtimeHash := sha256.Sum256(runtimeArchive.Bytes())
	modelHash := sha256.Sum256(model)
	var baseURL string
	manifest := Manifest{Version: 1,
		Runtime: Artifact{Size: int64(runtimeArchive.Len()), SHA256: hex.EncodeToString(runtimeHash[:])},
		Model:   Artifact{Size: int64(len(model)), SHA256: hex.EncodeToString(modelHash[:])},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			manifest.Runtime.URLs = []string{baseURL + "/runtime.zip"}
			manifest.Model.URLs = []string{baseURL + "/model-primary", baseURL + "/model-fallback"}
			_ = json.NewEncoder(w).Encode(manifest)
		case "/runtime.zip":
			_, _ = w.Write(runtimeArchive.Bytes())
		case "/model-primary":
			http.Error(w, "unavailable", http.StatusBadGateway)
		case "/model-fallback":
			_, _ = w.Write(model)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	baseURL = server.URL

	root := t.TempDir()
	installation, err := Ensure(context.Background(), EnsureOptions{ManifestURL: server.URL + "/manifest.json", DataDir: root})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if _, err := os.Stat(installation.Python); err != nil {
		t.Fatalf("python not installed: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(installation.ModelRuntime, "checkpoints", "video_depth_anything_vits.pth"))
	if err != nil || string(data) != string(model) {
		t.Fatalf("model = %q err=%v", data, err)
	}
}

func TestRuntimeLayoutKeepsMacPathsAndSeparatesWindowsVariants(t *testing.T) {
	root := t.TempDir()
	mac, err := runtimeLayout(root, "darwin-arm64", "mps")
	if err != nil {
		t.Fatal(err)
	}
	if mac.Python != filepath.Join(root, "runtimes", "depth", "v1", "darwin-arm64", ".venv", "bin", "python") {
		t.Fatalf("Mac Python path changed: %s", mac.Python)
	}
	if mac.Archive != filepath.Join(root, "downloads", "depth-runtime-v1-darwin-arm64.zip") {
		t.Fatalf("Mac archive path changed: %s", mac.Archive)
	}
	for _, variant := range []string{"cpu", "cuda"} {
		windows, err := runtimeLayout(root, "windows-amd64", variant)
		if err != nil {
			t.Fatal(err)
		}
		if windows.Python != filepath.Join(root, "runtimes", "depth", "v1", "windows-amd64", variant, ".python", "python.exe") {
			t.Fatalf("Windows %s Python path = %s", variant, windows.Python)
		}
		if windows.Archive != filepath.Join(root, "downloads", "depth-runtime-v1-windows-amd64-"+variant+".zip") {
			t.Fatalf("Windows %s archive path = %s", variant, windows.Archive)
		}
	}
	if _, err := runtimeLayout(root, "windows-amd64", "mps"); err == nil {
		t.Fatal("MPS must not select a Windows runtime")
	}
}

func TestEnsureInstallsSignedWindowsCPURuntime(t *testing.T) {
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	entry, _ := writer.Create(".python/python.exe")
	_, _ = entry.Write([]byte("windows-python"))
	entry, _ = writer.Create("worker/depth_capture/__init__.py")
	_, _ = entry.Write([]byte("# worker"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	model := []byte("model-weights")
	runtimeHash := sha256.Sum256(archive.Bytes())
	modelHash := sha256.Sum256(model)
	var baseURL string
	var envelope []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			_, _ = w.Write(envelope)
		case "/runtime.zip":
			_, _ = w.Write(archive.Bytes())
		case "/model":
			_, _ = w.Write(model)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	baseURL = server.URL
	manifest := Manifest{Version: 2, Runtimes: map[string]Artifact{
		"windows-amd64/cpu": {URLs: []string{baseURL + "/runtime.zip"}, Size: int64(archive.Len()), SHA256: hex.EncodeToString(runtimeHash[:]), Files: 2, ExpandedSize: int64(len("windows-python") + len("# worker"))},
	}, Model: Artifact{URLs: []string{baseURL + "/model"}, Size: int64(len(model)), SHA256: hex.EncodeToString(modelHash[:])}}
	var public []byte
	envelope, public = signedTestManifest(t, manifest)
	root := filepath.Join(t.TempDir(), "中文 path")
	installed, err := Ensure(context.Background(), EnsureOptions{ManifestURL: baseURL + "/manifest.json", DataDir: root, Platform: "windows-amd64", Variant: "cpu", TrustedPublicKey: public})
	if err != nil {
		t.Fatal(err)
	}
	if installed.Python != filepath.Join(root, "runtimes", "depth", "v1", "windows-amd64", "cpu", ".python", "python.exe") {
		t.Fatalf("python path = %s", installed.Python)
	}
	if !pathExists(installed.Python) || !pathExists(filepath.Join(installed.ToolDir, "depth_capture", "__init__.py")) {
		t.Fatal("runtime incomplete")
	}
}

func TestEnsureRejectsUnsignedWindowsManifestWithoutFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(Manifest{Version: 2, Runtimes: map[string]Artifact{"windows-amd64/cpu": {}}})
	}))
	defer server.Close()
	_, err := Ensure(context.Background(), EnsureOptions{ManifestURL: server.URL, DataDir: t.TempDir(), Platform: "windows-amd64", Variant: "cpu", TrustedPublicKey: make([]byte, 32), FallbackManifest: &Manifest{Version: 2}})
	if err == nil {
		t.Fatal("unsigned Windows manifest was accepted")
	}
}

func TestEnsureRejectsSignedWindowsArtifactWithoutExpandedBudget(t *testing.T) {
	manifest := Manifest{Version: 2, Runtimes: map[string]Artifact{
		"windows-amd64/cpu": {URLs: []string{"https://example.invalid/runtime.zip"}, Size: 1, SHA256: strings.Repeat("a", 64)},
	}}
	envelope, public := signedTestManifest(t, manifest)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(envelope)
	}))
	defer server.Close()
	_, err := Ensure(context.Background(), EnsureOptions{ManifestURL: server.URL, DataDir: t.TempDir(), Platform: "windows-amd64", Variant: "cpu", TrustedPublicKey: public})
	if err == nil || !strings.Contains(err.Error(), "解压体积") {
		t.Fatalf("missing signed shape was accepted: %v", err)
	}
}

func TestExtractRuntimeArchiveRejectsWindowsTraversalOnEveryHost(t *testing.T) {
	for _, name := range []string{`..\\escape`, `C:/escape`, `worker/../../escape`, `\absolute`, `\\server\share`, `worker\../../escape`, `/absolute`, `worker/C:escape`} {
		t.Run(name, func(t *testing.T) {
			var archive bytes.Buffer
			writer := zip.NewWriter(&archive)
			entry, err := writer.Create(name)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = entry.Write([]byte("bad"))
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "runtime.zip")
			if err := os.WriteFile(path, archive.Bytes(), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := extractRuntimeArchive(path, t.TempDir(), Artifact{}, 3<<30); err == nil {
				t.Fatal("unsafe archive path accepted")
			}
		})
	}
}

func TestExtractRuntimeArchiveWindowsSeparators(t *testing.T) {
	for _, collision := range []bool{false, true} {
		t.Run(fmt.Sprint(collision), func(t *testing.T) {
			var archive bytes.Buffer
			writer := zip.NewWriter(&archive)
			names := []string{`.python\python.exe`, `worker\depth_capture\__init__.py`}
			if collision {
				names = append(names, ".python/python.exe")
			}
			for _, name := range names {
				entry, err := writer.Create(name)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := entry.Write([]byte("content")); err != nil {
					t.Fatal(err)
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "runtime.zip")
			if err := os.WriteFile(path, archive.Bytes(), 0o600); err != nil {
				t.Fatal(err)
			}
			destination := t.TempDir()
			err := extractRuntimeArchive(path, destination, Artifact{}, 3<<30)
			if collision {
				if err == nil {
					t.Fatal("normalized duplicate was accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, name := range names {
				contents, err := os.ReadFile(filepath.Join(destination, filepath.FromSlash(strings.ReplaceAll(name, `\`, "/"))))
				if err != nil || string(contents) != "content" {
					t.Fatalf("%s: %q %v", name, contents, err)
				}
			}
		})
	}
}

func TestEnsureRejectsRuntimeArchiveTraversal(t *testing.T) {
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	entry, _ := writer.Create("../escape")
	_, _ = entry.Write([]byte("bad"))
	_ = writer.Close()
	hash := sha256.Sum256(archive.Bytes())
	manifest := Manifest{Version: 1, Runtime: Artifact{Size: int64(archive.Len()), SHA256: hex.EncodeToString(hash[:])}, Model: Artifact{Size: 1, SHA256: string(make([]byte, 64))}}
	var baseURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/manifest.json" {
			manifest.Runtime.URLs = []string{baseURL + "/runtime.zip"}
			manifest.Model.URLs = []string{baseURL + "/model"}
			_ = json.NewEncoder(w).Encode(manifest)
			return
		}
		_, _ = w.Write(archive.Bytes())
	}))
	defer server.Close()
	baseURL = server.URL

	root := t.TempDir()
	if _, err := Ensure(context.Background(), EnsureOptions{ManifestURL: server.URL + "/manifest.json", DataDir: root}); err == nil {
		t.Fatal("expected traversal rejection")
	}
	if _, err := os.Stat(filepath.Join(root, "escape")); !os.IsNotExist(err) {
		t.Fatalf("archive escaped install root: %v", err)
	}
}

func TestEnsureRetriesManifestAfterTransientEOF(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests == 1 {
			panic(http.ErrAbortHandler)
		}
		_ = json.NewEncoder(w).Encode(Manifest{Version: 99})
	}))
	defer server.Close()

	_, err := Ensure(context.Background(), EnsureOptions{ManifestURL: server.URL, DataDir: t.TempDir()})
	if err == nil || requests != 2 {
		t.Fatalf("err=%v requests=%d", err, requests)
	}
}

func TestEnsureUsesTrustedFallbackManifestWhenRemoteIsUnavailable(t *testing.T) {
	fallback := Manifest{Version: 99}
	_, err := Ensure(context.Background(), EnsureOptions{
		ManifestURL:      "http://127.0.0.1:1/unavailable",
		FallbackManifest: &fallback,
		DataDir:          t.TempDir(),
	})
	if err == nil || err.Error() != "不支持的深度组件清单版本 99" {
		t.Fatalf("expected fallback manifest to be used, got %v", err)
	}
}

func TestValidateArchiveShapeAcceptsTheVerifiedOfficialRuntime(t *testing.T) {
	artifact := Artifact{Files: 23_481, ExpandedSize: 955_790_953}
	if err := validateArchiveShape(23_481, 955_790_953, artifact, 3<<30); err != nil {
		t.Fatalf("official runtime rejected: %v", err)
	}
}

func TestWindowsArchiveLimitAcceptsMeasuredCPUPackageWithoutRelaxingMac(t *testing.T) {
	const expanded = int64(3_801_320_647)
	artifact := Artifact{Files: 25_000, ExpandedSize: expanded}
	if err := validateArchiveShape(25_000, expanded, artifact, 3<<30); err == nil {
		t.Fatal("Mac archive limit unexpectedly accepted the Windows package")
	}
	if err := validateArchiveShape(25_000, expanded, artifact, 12<<30); err != nil {
		t.Fatalf("measured Windows CPU package was rejected: %v", err)
	}
	if err := validateArchiveShape(25_000, expanded+1, artifact, 12<<30); err == nil {
		t.Fatal("signed Windows expanded size was ignored")
	}
	if err := validateArchiveShape(25_000, 12<<30+1, Artifact{}, 12<<30); err == nil {
		t.Fatal("Windows absolute archive limit was ignored")
	}
}

func TestPublishWindowsRuntimePreservesPreviousInstallIfStageFails(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime")
	if err := os.Mkdir(root, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sentinel"), []byte("previous"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := publishWindowsRuntime(filepath.Join(t.TempDir(), "missing-stage"), root); err == nil {
		t.Fatal("missing stage was accepted")
	}
	data, err := os.ReadFile(filepath.Join(root, "sentinel"))
	if err != nil || string(data) != "previous" {
		t.Fatalf("previous installation was lost: %q %v", data, err)
	}
}

func TestPublishWindowsRuntimeReplacesOnlyAfterCompleteStage(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "runtime")
	stage := filepath.Join(parent, "stage")
	for _, dir := range []string{root, stage} {
		if err := os.Mkdir(dir, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(filepath.Join(root, "old"), []byte("old"), 0o600)
	_ = os.WriteFile(filepath.Join(stage, "new"), []byte("new"), 0o600)
	if err := publishWindowsRuntime(stage, root); err != nil {
		t.Fatal(err)
	}
	if !pathExists(filepath.Join(root, "new")) || pathExists(filepath.Join(root, "old")) {
		t.Fatal("Windows runtime was not replaced cleanly")
	}
}

func TestValidateArchiveShapeRejectsManifestMismatchAndAbsoluteLimit(t *testing.T) {
	artifact := Artifact{Files: 23_481, ExpandedSize: 955_790_953}
	if err := validateArchiveShape(23_480, 955_790_953, artifact, 3<<30); err == nil {
		t.Fatal("expected manifest file-count mismatch")
	}
	if err := validateArchiveShape(50_001, 1, Artifact{}, 3<<30); err == nil {
		t.Fatal("expected absolute file-count rejection")
	}
}

func TestExtractRuntimeArchivePreservesTrustedExecutableBit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not expose POSIX executable permissions")
	}
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	header := &zip.FileHeader{Name: ".python/bin/python3.11", Method: zip.Deflate}
	header.SetMode(0o755)
	entry, err := writer.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = entry.Write([]byte("python"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	destination := t.TempDir()
	if err := os.WriteFile(filepath.Join(destination, "runtime.zip"), archive.Bytes(), 0o640); err != nil {
		t.Fatal(err)
	}
	artifact := Artifact{Files: 1, ExpandedSize: 6}
	if err := extractRuntimeArchive(filepath.Join(destination, "runtime.zip"), filepath.Join(destination, "out"), artifact, 3<<30); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(destination, "out", ".python", "bin", "python3.11"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o750 {
		t.Fatalf("mode = %o", info.Mode().Perm())
	}
}

func TestEnsureInstallsTheOfficialRuntimeArchive(t *testing.T) {
	archiveSource := os.Getenv("BEEFTV_TEST_DEPTH_RUNTIME_ARCHIVE")
	if archiveSource == "" {
		t.Skip("set BEEFTV_TEST_DEPTH_RUNTIME_ARCHIVE for the release-artifact integration test")
	}
	model := []byte("integration-model-placeholder")
	modelHash := sha256.Sum256(model)
	manifest := Manifest{Version: 1,
		Runtime: Artifact{URLs: []string{"unused"}, Size: 294_629_974, SHA256: "f606dee084ec9d38d76a80e409e4cb9a80ad7db51c18778285a63e8f24376682", Files: 23_481, ExpandedSize: 955_790_953},
		Model:   Artifact{Size: int64(len(model)), SHA256: hex.EncodeToString(modelHash[:])},
	}
	var baseURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			manifest.Model.URLs = []string{baseURL + "/model"}
			_ = json.NewEncoder(w).Encode(manifest)
		case "/model":
			_, _ = w.Write(model)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	baseURL = server.URL

	root := t.TempDir()
	archiveTarget := filepath.Join(root, "downloads", "depth-runtime-v1-darwin-arm64.zip")
	if err := os.MkdirAll(filepath.Dir(archiveTarget), 0o750); err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(archiveSource)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	target, err := os.Create(archiveTarget)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(target, source); err != nil {
		t.Fatal(err)
	}
	if err := target.Close(); err != nil {
		t.Fatal(err)
	}

	installation, err := Ensure(context.Background(), EnsureOptions{ManifestURL: baseURL + "/manifest.json", DataDir: root})
	if err != nil {
		t.Fatalf("install official runtime: %v", err)
	}
	for _, path := range []string{installation.Python, filepath.Join(installation.ToolDir, "depth_capture", "__main__.py")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("installed path %s: %v", path, err)
		}
	}
}

func TestEnsureLiveDepthRuntime(t *testing.T) {
	dataDir := os.Getenv("BEEFTV_TEST_DEPTH_LIVE_DATA_DIR")
	if dataDir == "" {
		t.Skip("set BEEFTV_TEST_DEPTH_LIVE_DATA_DIR for the live installation check")
	}
	installation, err := Ensure(context.Background(), EnsureOptions{
		ManifestURL: "https://github.com/glanderness/BeefTV/releases/download/v1.5.5/depth-runtime-manifest.json",
		DataDir:     dataDir,
	})
	if err != nil {
		t.Fatalf("live install: %v", err)
	}
	for _, path := range []string{
		installation.Python,
		filepath.Join(installation.ToolDir, "depth_capture", "__main__.py"),
		filepath.Join(installation.ModelRuntime, "checkpoints", "video_depth_anything_vits.pth"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("installed path %s: %v", path, err)
		}
	}
}
