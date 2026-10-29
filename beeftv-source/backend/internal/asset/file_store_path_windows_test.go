//go:build windows

package asset

import (
	"strings"
	"testing"
)

func TestFileStoreRejectsWindowsRootedAndVolumeKeys(t *testing.T) {
	store := NewFileStore(t.TempDir())
	invalid := []string{
		"/absolute",
		`\absolute`,
		`C:\Windows\Temp\x.png`,
		"C:foo",
		`\\server\share\file`,
		"//server/share/file",
		`\\?\C:\x.png`,
	}
	for _, key := range invalid {
		if _, err := store.path(key); err == nil {
			t.Fatalf("path(%q) accepted invalid key", key)
		}
		if err := store.Write(key, strings.NewReader("x")); err == nil {
			t.Fatalf("Write(%q) accepted invalid key", key)
		}
	}

	const valid = "workspaces/local/video/result.mp4"
	located, err := store.path(valid)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(located, `\workspaces\local\video\result.mp4`) {
		t.Fatalf("path(%q) = %q, want a store-relative slash key", valid, located)
	}
	if err := store.Write(valid, strings.NewReader("ok")); err != nil {
		t.Fatalf("Write(%q) rejected a valid slash key: %v", valid, err)
	}
}
