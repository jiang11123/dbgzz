package skillhub

import (
	"archive/zip"
	"bytes"
	"testing"
)

func TestVerifyArchiveRejectsUnlistedPathsAndDigestChanges(t *testing.T) {
	files := map[string][]byte{"SKILL.md": []byte("---\nname: example\ndescription: Example\n---\nInstructions\n")}
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	entry, _ := writer.Create("SKILL.md")
	entry.Write(files["SKILL.md"])
	writer.Close()
	release := &Release{ArchiveSHA256: Digest(data.Bytes()), ArchiveBytes: int64(data.Len()), ContentHash: ContentDigest(files), Files: []File{{Path: "SKILL.md", SHA256: Digest(files["SKILL.md"]), Size: int64(len(files["SKILL.md"]))}}}
	if _, err := VerifyArchive(data.Bytes(), release); err != nil {
		t.Fatal(err)
	}
	release.Files[0].SHA256 = "wrong"
	if _, err := VerifyArchive(data.Bytes(), release); err == nil {
		t.Fatal("file digest mismatch accepted")
	}
	release.Files[0].SHA256 = Digest(files["SKILL.md"])
	release.Files = append(release.Files, release.Files[0])
	if _, err := VerifyArchive(data.Bytes(), release); err == nil {
		t.Fatal("duplicate manifest path accepted")
	}
	for _, name := range []string{"../escape", "x/../escape", "/absolute", "a\\b", "a:b", "x/.git/config", "CON.txt", "a/trailing.", "a/b?c", "__MACOSX/a"} {
		if SafeFilePath(name) {
			t.Errorf("unsafe path accepted: %q", name)
		}
	}
}

func TestVerifyArchiveRejectsScriptsEvenWhenTheirDigestsMatch(t *testing.T) {
	for _, name := range []string{"scripts/run.py", "tool.py", "node_modules/example/data.json"} {
		t.Run(name, func(t *testing.T) {
			files := map[string][]byte{"SKILL.md": []byte("---\nname: example\ndescription: Example\n---\nRun the attached file."), name: []byte("content")}
			var data bytes.Buffer
			writer := zip.NewWriter(&data)
			release := &Release{ContentHash: ContentDigest(files)}
			for path, content := range files {
				entry, _ := writer.Create(path)
				entry.Write(content)
				release.Files = append(release.Files, File{Path: path, Size: int64(len(content)), SHA256: Digest(content)})
			}
			writer.Close()
			release.ArchiveBytes = int64(data.Len())
			release.ArchiveSHA256 = Digest(data.Bytes())
			if _, err := VerifyArchive(data.Bytes(), release); err == nil {
				t.Fatal("script package accepted for host installation")
			}
		})
	}
}
