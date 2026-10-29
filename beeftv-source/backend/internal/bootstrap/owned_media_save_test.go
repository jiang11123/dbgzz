package bootstrap

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
)

type failAfterReader struct {
	leftover []byte
	err      error
}

func (r *failAfterReader) Read(p []byte) (int, error) {
	if len(r.leftover) > 0 {
		n := copy(p, r.leftover)
		r.leftover = r.leftover[n:]
		if len(r.leftover) == 0 {
			return n, r.err
		}
		return n, nil
	}
	return 0, r.err
}

func TestSanitizeOwnedResourceIDRejectsTraversalAndURLs(t *testing.T) {
	for _, id := range []string{"", "../secret", "a/b", `a\b`, "http://example.com/x", "resource:abc", "abc def", strings.Repeat("a", 129)} {
		if _, err := sanitizeOwnedResourceID(id); err == nil {
			t.Fatalf("sanitizeOwnedResourceID(%q) succeeded", id)
		}
	}
	got, err := sanitizeOwnedResourceID("  abcdef0123456789  ")
	if err != nil {
		t.Fatal(err)
	}
	if got != "abcdef0123456789" {
		t.Fatalf("id = %q", got)
	}
}

func TestSanitizeSaveFileNameStripsPathsAndIllegalCharacters(t *testing.T) {
	got := sanitizeSaveFileName(`../evil:name?.mp4`)
	if strings.ContainsAny(got, `\/:*?"<>|`) || strings.Contains(got, "..") || !strings.HasSuffix(got, ".mp4") {
		t.Fatalf("sanitizeSaveFileName() = %q", got)
	}
	if got := sanitizeSaveFileName(" /tmp/clip.mp4 "); got != "clip.mp4" {
		t.Fatalf("basename = %q", got)
	}
	if got := sanitizeSaveFileName(".."); got != "未命名媒体" {
		t.Fatalf("dot name = %q", got)
	}
}

func TestSanitizeSaveFileNameDoesNotSplitChineseRunes(t *testing.T) {
	name := strings.Repeat("好", 80) + ".mp4"
	got := sanitizeSaveFileName(name)
	if !utf8.ValidString(got) {
		t.Fatalf("truncated name is not valid UTF-8: %q", got)
	}
	if !strings.HasSuffix(got, ".mp4") {
		t.Fatalf("missing extension: %q", got)
	}
	if len(got) > maxSaveFileNameBytes {
		t.Fatalf("len(%q) = %d", got, len(got))
	}
	for _, r := range got[:len(got)-4] {
		if r != '好' && r != '_' {
			t.Fatalf("unexpected rune %q in %q", r, got)
		}
	}
}

func TestOpenLocalOwnedResourceFileRejectsNonLocalProvider(t *testing.T) {
	dir := t.TempDir()
	_, err := openLocalOwnedResourceFile(&model.Resource{
		ID:        "abc",
		Provider:  "oss",
		Status:    model.ResourceStatusReady,
		ObjectKey: "workspaces/local/video/clip.mp4",
	}, dir)
	if err == nil {
		t.Fatal("expected non-local provider to be rejected")
	}
}

func TestWriteOwnedFileAtomicallyPreservesExistingDestOnReadFailure(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "keep.bin")
	if err := os.WriteFile(dest, []byte("ORIGINAL"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := writeOwnedFileAtomically(dest, &failAfterReader{leftover: []byte("xx"), err: errors.New("read failed")}, nil)
	if err == nil {
		t.Fatal("expected copy failure")
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "ORIGINAL" {
		t.Fatalf("dest = %q", got)
	}
	assertNoSaveTemps(t, dir)
}

func TestWriteOwnedFileAtomicallyPreservesExistingDestOnWriteFailure(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "keep.bin")
	if err := os.WriteFile(dest, []byte("ORIGINAL"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := writeOwnedFileAtomically(dest, &failAfterReader{err: errors.New("write failed")}, nil)
	if err == nil {
		t.Fatal("expected copy failure")
	}
	got, _ := os.ReadFile(dest)
	if string(got) != "ORIGINAL" {
		t.Fatalf("dest = %q", got)
	}
	assertNoSaveTemps(t, dir)
}

func TestWriteOwnedFileAtomicallyReplacesDestOnlyAfterSuccess(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "keep.bin")
	if err := os.WriteFile(dest, []byte("ORIGINAL"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeOwnedFileAtomically(dest, strings.NewReader("NEXT"), nil); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "NEXT" {
		t.Fatalf("dest = %q", got)
	}
	assertNoSaveTemps(t, dir)
}

func TestWriteOwnedArtifactRejectsOversizedPayload(t *testing.T) {
	err := WriteOwnedArtifact(filepath.Join(t.TempDir(), "out.zip"), make([]byte, maxOwnedArtifactBytes+1))
	if err == nil {
		t.Fatal("expected oversized artifact to be rejected")
	}
}

func TestReplaceFileLeavesAdjacentOldFileAlone(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "keep.bin")
	adjacent := dest + ".beeftv-old"
	tmp := filepath.Join(dir, ".beeftv-save-x")
	if err := os.WriteFile(dest, []byte("ORIGINAL"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(adjacent, []byte("USER-OLD"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tmp, []byte("NEXT"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := replaceFile(tmp, dest); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "NEXT" {
		t.Fatalf("dest = %q", got)
	}
	old, err := os.ReadFile(adjacent)
	if err != nil {
		t.Fatal(err)
	}
	if string(old) != "USER-OLD" {
		t.Fatalf("adjacent = %q", old)
	}
}

func TestReplaceFileFailurePreservesOriginalAndAdjacentOld(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "keep.bin")
	adjacent := dest + ".beeftv-old"
	if err := os.Mkdir(dest, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(adjacent, []byte("USER-OLD"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := writeOwnedFileAtomically(dest, strings.NewReader("NEXT"), nil)
	if err == nil {
		t.Fatal("expected replace of a directory to fail")
	}
	info, err := os.Stat(dest)
	if err != nil || !info.IsDir() {
		t.Fatalf("dest should still be the original directory: %v", err)
	}
	old, err := os.ReadFile(adjacent)
	if err != nil {
		t.Fatal(err)
	}
	if string(old) != "USER-OLD" {
		t.Fatalf("adjacent = %q", old)
	}
	assertNoSaveTemps(t, dir)
}

func assertNoSaveTemps(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".beeftv-save-") {
			t.Fatalf("leftover temp %s", entry.Name())
		}
	}
}
