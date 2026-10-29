package eagle

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustEvalSymlinks(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func TestOriginalPathResolvesSiblingMediaAndJailsEscape(t *testing.T) {
	root := t.TempDir()
	itemID := "item-1"
	itemDir := filepath.Join(root, "images", itemID+".info")
	if err := os.MkdirAll(itemDir, 0o750); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(itemDir, "photo.jpg")
	thumbnail := filepath.Join(itemDir, "photo_thumbnail.jpg")
	if err := os.WriteFile(original, []byte("orig"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(thumbnail, []byte("thumb"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(itemDir, "metadata.json"), []byte(`{}`), 0o640); err != nil {
		t.Fatal(err)
	}

	got, err := originalPath(thumbnail, itemID, root)
	if err != nil {
		t.Fatal(err)
	}
	if got != mustEvalSymlinks(t, original) {
		t.Fatalf("originalPath = %q, want %q", got, mustEvalSymlinks(t, original))
	}

	secretDir := t.TempDir()
	secret := filepath.Join(secretDir, "secret.bin")
	if err := os.WriteFile(secret, []byte("secret"), 0o640); err != nil {
		t.Fatal(err)
	}
	_, err = originalPath(secret, itemID, root)
	if err == nil || !strings.Contains(err.Error(), "不在当前素材库内") {
		t.Fatalf("escaped thumbnail error = %v", err)
	}

	escaped := filepath.Join(itemDir, "..", "..", "..", filepath.Base(secretDir), "secret.bin")
	_, err = originalPath(escaped, itemID, root)
	if err == nil || !strings.Contains(err.Error(), "不在当前素材库内") {
		t.Fatalf("relative escape error = %v", err)
	}

	_, err = originalPath(thumbnail, itemID, "relative-library")
	if err == nil || !strings.Contains(err.Error(), "素材库路径无效") {
		t.Fatalf("relative library error = %v", err)
	}
}

func TestOriginalPathSkipsThumbnailAndMetadataWhenStemMissing(t *testing.T) {
	root := t.TempDir()
	itemID := "item-2"
	itemDir := filepath.Join(root, "images", itemID+".info")
	if err := os.MkdirAll(itemDir, 0o750); err != nil {
		t.Fatal(err)
	}
	thumbnail := filepath.Join(itemDir, "preview_thumbnail.webp")
	fallback := filepath.Join(itemDir, "clip.mp4")
	if err := os.WriteFile(thumbnail, []byte("thumb"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(itemDir, "metadata.json"), []byte(`{}`), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fallback, []byte("video"), 0o640); err != nil {
		t.Fatal(err)
	}

	got, err := originalPath(thumbnail, itemID, root)
	if err != nil {
		t.Fatal(err)
	}
	if got != mustEvalSymlinks(t, fallback) {
		t.Fatalf("originalPath = %q, want %q", got, mustEvalSymlinks(t, fallback))
	}
}

func TestPathJailCanonicalizesLibrarySymlinkAndRejectsEscapingSymlinks(t *testing.T) {
	realRoot := t.TempDir()
	itemID := "item-link"
	itemDir := filepath.Join(realRoot, "images", itemID+".info")
	if err := os.MkdirAll(itemDir, 0o750); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(itemDir, "photo.jpg")
	thumbnail := filepath.Join(itemDir, "photo_thumbnail.jpg")
	if err := os.WriteFile(original, []byte("orig"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(thumbnail, []byte("thumb"), 0o640); err != nil {
		t.Fatal(err)
	}

	linkedRoot := filepath.Join(t.TempDir(), "library-link")
	if err := os.Symlink(realRoot, linkedRoot); err != nil {
		t.Fatal(err)
	}
	got, err := originalPath(thumbnail, itemID, linkedRoot)
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(original)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("library symlink originalPath = %q, want %q", got, want)
	}
	gotThumb, err := thumbnailInsideLibrary(thumbnail, itemID, linkedRoot)
	if err != nil {
		t.Fatal(err)
	}
	wantThumb, err := filepath.EvalSymlinks(thumbnail)
	if err != nil {
		t.Fatal(err)
	}
	if gotThumb != wantThumb {
		t.Fatalf("library symlink thumbnail = %q, want %q", gotThumb, wantThumb)
	}

	secretDir := t.TempDir()
	secretFile := filepath.Join(secretDir, "secret.bin")
	if err := os.WriteFile(secretFile, []byte("secret"), 0o640); err != nil {
		t.Fatal(err)
	}
	fileLinkItem := "file-link"
	fileLinkDir := filepath.Join(realRoot, "images", fileLinkItem+".info")
	if err := os.MkdirAll(fileLinkDir, 0o750); err != nil {
		t.Fatal(err)
	}
	linkedPhoto := filepath.Join(fileLinkDir, "photo.jpg")
	linkedThumb := filepath.Join(fileLinkDir, "photo_thumbnail.jpg")
	if err := os.Symlink(secretFile, linkedPhoto); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(linkedThumb, []byte("thumb"), 0o640); err != nil {
		t.Fatal(err)
	}
	_, err = originalPath(linkedThumb, fileLinkItem, realRoot)
	if err == nil || !strings.Contains(err.Error(), "原始文件不存在") {
		t.Fatalf("file symlink escape error = %v", err)
	}

	outsideItem := t.TempDir()
	outsideThumb := filepath.Join(outsideItem, "thumb.jpg")
	if err := os.WriteFile(outsideThumb, []byte("out"), 0o640); err != nil {
		t.Fatal(err)
	}
	dirLinkItem := "dir-link"
	dirLinkPath := filepath.Join(realRoot, "images", dirLinkItem+".info")
	if err := os.MkdirAll(filepath.Dir(dirLinkPath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideItem, dirLinkPath); err != nil {
		t.Fatal(err)
	}
	_, err = originalPath(filepath.Join(dirLinkPath, "thumb.jpg"), dirLinkItem, realRoot)
	if err == nil || !strings.Contains(err.Error(), "不在当前素材库内") {
		t.Fatalf("item dir symlink escape error = %v", err)
	}
	_, err = thumbnailInsideLibrary(filepath.Join(dirLinkPath, "thumb.jpg"), dirLinkItem, realRoot)
	if err == nil || !strings.Contains(err.Error(), "不在当前素材库内") {
		t.Fatalf("item dir symlink thumbnail error = %v", err)
	}

	insideAlias := filepath.Join(itemDir, "alias.jpg")
	if err := os.Symlink(original, insideAlias); err != nil {
		t.Fatal(err)
	}
	aliasThumb := filepath.Join(itemDir, "alias_thumbnail.jpg")
	if err := os.WriteFile(aliasThumb, []byte("thumb"), 0o640); err != nil {
		t.Fatal(err)
	}
	got, err = originalPath(aliasThumb, itemID, realRoot)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("in-library file symlink = %q, want %q", got, want)
	}

	_, err = originalPath(thumbnail, itemID, "relative-library")
	if err == nil || !strings.Contains(err.Error(), "素材库路径无效") {
		t.Fatalf("relative library error = %v", err)
	}
	_, err = thumbnailInsideLibrary(thumbnail, itemID, "relative-library")
	if err == nil || !strings.Contains(err.Error(), "素材库路径无效") {
		t.Fatalf("relative library thumbnail error = %v", err)
	}
}

func TestPathFunctionsRejectItemIDTraversalWithoutHandler(t *testing.T) {
	root := t.TempDir()
	thumbnail := filepath.Join(root, "images", "item-1.info", "photo_thumbnail.jpg")
	if err := os.MkdirAll(filepath.Dir(thumbnail), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(thumbnail, []byte("thumb"), 0o640); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"..", "../etc", "..\\etc", "a/../../etc", "a/b"} {
		if _, err := originalPath(thumbnail, id, root); err == nil || !strings.Contains(err.Error(), "素材 ID 无效") {
			t.Fatalf("originalPath itemID %q error = %v", id, err)
		}
		if _, err := thumbnailInsideLibrary(thumbnail, id, root); err == nil || !strings.Contains(err.Error(), "素材 ID 无效") {
			t.Fatalf("thumbnailInsideLibrary itemID %q error = %v", id, err)
		}
	}
}

func TestThumbnailInsideLibraryRejectsEscape(t *testing.T) {
	root := t.TempDir()
	itemID := "item-3"
	itemDir := filepath.Join(root, "images", itemID+".info")
	if err := os.MkdirAll(itemDir, 0o750); err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(itemDir, "thumb.jpg")
	if err := os.WriteFile(inside, []byte("ok"), 0o640); err != nil {
		t.Fatal(err)
	}
	got, err := thumbnailInsideLibrary(inside, itemID, root)
	if err != nil {
		t.Fatal(err)
	}
	if got != mustEvalSymlinks(t, inside) {
		t.Fatalf("thumbnailInsideLibrary = %q", got)
	}
	outside := filepath.Join(root, "other.jpg")
	if err := os.WriteFile(outside, []byte("no"), 0o640); err != nil {
		t.Fatal(err)
	}
	_, err = thumbnailInsideLibrary(outside, itemID, root)
	if err == nil || !strings.Contains(err.Error(), "不在当前素材库内") {
		t.Fatalf("outside thumbnail error = %v", err)
	}
}
