package desktopupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestRepeatedInvalidInstallerNeverExitsOrAccumulatesPayloads(t *testing.T) {
	pub, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	// Signed transport bytes can still be an invalid archive/layout.
	invalid := []byte("not an installer archive")
	sum := sha256.Sum256(invalid)
	server := signedFeedServer(t, priv, testPayload("v1.6.0", "darwin-arm64", "", hex.EncodeToString(sum[:]), int64(len(invalid)), ""), invalid)
	engine := testEngine(t, pub, server, "v1.5.1", "darwin-arm64")
	installRoot := t.TempDir()
	if err := WriteDarwinLayout(installRoot, "OLD"); err != nil {
		t.Fatal(err)
	}
	engine.locate = func() (Target, error) {
		return Target{Path: filepath.Join(installRoot, appBundleName), Platform: "darwin-arm64"}, nil
	}
	engine.quit = func() error { t.Error("invalid installer must not quit"); return nil }
	engine.helper = func(HelperRequest) error { t.Error("invalid installer must not start helper"); return nil }
	keep := filepath.Join(engine.stagingRoot, "another-download")
	if err := os.MkdirAll(keep, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.CheckForUpdate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.DownloadUpdate(context.Background()); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if err := engine.InstallUpdate(context.Background()); err == nil {
			t.Fatal("invalid package accepted")
		}
		entries, err := os.ReadDir(installRoot)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if entry.Name() != appBundleName {
				t.Fatalf("failed installer left staging %s", entry.Name())
			}
		}
		if _, err := os.Stat(keep); err != nil {
			t.Fatal("another download removed", err)
		}
		if _, err := os.Stat(engine.staged.archive); err != nil {
			t.Fatal("retry lost archive", err)
		}
	}
}
