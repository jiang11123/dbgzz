package desktopupdate

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSanitizeZipNameRejectsUnsafePaths(t *testing.T) {
	t.Parallel()
	cases := []string{
		"../etc/passwd",
		"/tmp/x",
		"//server/share/x",
		`C:/Windows/BeefTV.exe`,
		`C:\Windows\BeefTV.exe`,
		`\\server\share\x`,
		"BeefTV.app/../../outside",
		"BeefTV.app/Contents/MacOS/./BeefTV",
		"",
		"\x00foo",
	}
	for _, name := range cases {
		if _, _, err := sanitizeZipName(name); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	rel, dir, err := sanitizeZipName("BeefTV.app/Contents/MacOS/BeefTV")
	if err != nil || dir || rel != "BeefTV.app/Contents/MacOS/BeefTV" {
		t.Fatalf("got %q dir=%v err=%v", rel, dir, err)
	}
}

func TestExtractSecureZipRejectsMaliciousArchives(t *testing.T) {
	root := t.TempDir()
	limits := extractLimits{MaxFiles: 8, MaxEntryBytes: 64, MaxTotalBytes: 128}

	t.Run("zip-slip", func(t *testing.T) {
		path := writeRawZip(t, root, "slip.zip", map[string][]byte{"../escape.txt": []byte("nope")})
		if err := extractSecureZip(path, filepath.Join(root, "out-slip"), limits); err == nil {
			t.Fatal("expected zip-slip rejection")
		}
		if _, err := os.Lstat(filepath.Join(root, "escape.txt")); err == nil {
			t.Fatal("zip-slip wrote outside dest")
		}
	})

	t.Run("symlink", func(t *testing.T) {
		path := filepath.Join(root, "link.zip")
		file, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		writer := zip.NewWriter(file)
		header := &zip.FileHeader{Name: "BeefTV.app/Contents/MacOS/BeefTV"}
		header.SetMode(os.ModeSymlink | 0o755)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte("/tmp/evil")); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		file.Close()
		if err := extractSecureZip(path, filepath.Join(root, "out-link"), limits); err == nil {
			t.Fatal("expected symlink rejection")
		}
	})

	t.Run("duplicate", func(t *testing.T) {
		path := filepath.Join(root, "dup.zip")
		file, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		writer := zip.NewWriter(file)
		for i := 0; i < 2; i++ {
			entry, err := writer.Create("BeefTV.app/Contents/MacOS/BeefTV")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := entry.Write([]byte("x")); err != nil {
				t.Fatal(err)
			}
		}
		writer.Close()
		file.Close()
		if err := extractSecureZip(path, filepath.Join(root, "out-dup"), limits); err == nil {
			t.Fatal("expected duplicate rejection")
		}
	})

	t.Run("zip-bomb", func(t *testing.T) {
		path := writeRawZip(t, root, "bomb.zip", map[string][]byte{"a.bin": []byte(strings.Repeat("a", 200))})
		if err := extractSecureZip(path, filepath.Join(root, "out-bomb"), limits); err == nil {
			t.Fatal("expected zip-bomb rejection")
		}
	})
}

func TestValidateLayoutRejectsWrongExecutable(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, appBundleName, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, appBundleName, "Contents", "MacOS", "Other"), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := validateExtractedLayout(root, "darwin-arm64"); err == nil {
		t.Fatal("expected missing executable")
	}

	win := t.TempDir()
	if err := os.WriteFile(filepath.Join(win, "readme.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := validateExtractedLayout(win, "windows-amd64"); err == nil {
		t.Fatal("expected missing windows layout")
	}
}

func TestValidateDarwinLayoutAcceptsBundle(t *testing.T) {
	root := t.TempDir()
	if err := WriteDarwinLayout(root, "ok"); err != nil {
		t.Fatal(err)
	}
	if err := validateExtractedLayout(root, "darwin-arm64"); err != nil {
		t.Fatal(err)
	}
}

func writeRawZip(t *testing.T, dir, name string, files map[string][]byte) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := WriteZip(path, files, nil); err != nil {
		t.Fatal(err)
	}
	return path
}
