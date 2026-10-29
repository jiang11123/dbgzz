package desktopupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtractionProgressAndCancellation(t *testing.T) {
	root := t.TempDir()
	archive := writeRawZip(t, root, "payload.zip", map[string][]byte{"one": []byte("one"), "two": []byte("two")})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var counts []int
	err := extractSecureZipWithProgress(ctx, archive, filepath.Join(root, "out"), defaultExtractLimits(), func(done, total int) {
		if total != 2 {
			t.Errorf("total=%d", total)
		}
		counts = append(counts, done)
		if done == 1 {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) || len(counts) != 2 || counts[0] != 0 || counts[1] != 1 {
		t.Fatalf("counts=%v err=%v", counts, err)
	}
	counts = nil
	err = extractSecureZipWithProgress(context.Background(), archive, filepath.Join(root, "retry"), defaultExtractLimits(), func(done, total int) { counts = append(counts, done) })
	if err != nil || len(counts) != 3 || counts[2] != 2 {
		t.Fatalf("retry counts=%v err=%v", counts, err)
	}
}

func TestFailedPreparationRetainsStageUntilRetry(t *testing.T) {
	e := &Engine{state: UpdateState{Status: StatusInstalling, Phase: "extracting", CompletedFiles: 37, TotalFiles: 15000}}
	e.fail(preparationTimeoutMessage(e.snapshot().Phase))
	failed := e.snapshot()
	if failed.Phase != "extracting" || failed.CompletedFiles != 37 || !strings.Contains(failed.Error, "解压更新包超时") {
		t.Fatalf("%+v", failed)
	}
	e.set(func(s *UpdateState) { s.Status = StatusInstalling; s.Error = "" })
	if next := e.snapshot(); next.Phase != "" || next.CompletedFiles != 0 || next.TotalFiles != 0 {
		t.Fatalf("retry has stale progress: %+v", next)
	}
	if !strings.Contains(preparationTimeoutMessage("verifying"), "校验更新包超时") {
		t.Fatal("lost verification stage")
	}
}

func TestInstallTimeoutAfterPreviousFailureResetsActualStage(t *testing.T) {
	root := t.TempDir()
	e := &Engine{
		enabled: true, currentVersion: "v1.7.20", logPath: filepath.Join(root, "update.log"),
		state:  UpdateState{Status: StatusError, Phase: "extracting", CompletedFiles: 37, TotalFiles: 15000},
		staged: &stagedUpdate{archive: filepath.Join(root, "update.zip"), platform: "darwin-arm64"},
		locate: func() (Target, error) {
			return Target{Path: filepath.Join(root, appBundleName), Platform: "darwin-arm64"}, nil
		},
		helper: func(HelperRequest) error { t.Fatal("canceled update must not start helper"); return nil },
	}
	if err := os.WriteFile(e.staged.archive, nil, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := e.InstallUpdate(ctx); err == nil {
		t.Fatal("canceled install succeeded")
	}
	state := e.snapshot()
	if state.Status != StatusError || state.Phase != "verifying" || state.CompletedFiles != 0 || state.TotalFiles != 0 || !strings.Contains(state.Error, "校验更新包超时") {
		t.Fatalf("stale failure: %+v", state)
	}
	log, err := os.ReadFile(e.logPath)
	if err != nil || !strings.Contains(string(log), "phase=verifying completedFiles=0 totalFiles=0 timeout=true") {
		t.Fatalf("wrong failure log: %s %v", log, err)
	}
}

func TestInvalidLayoutAndCanceledPreparationLeaveOldApplication(t *testing.T) {
	for _, scenario := range []string{"layout", "canceled", "traversal"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			if err := WriteDarwinLayout(root, "OLD"); err != nil {
				t.Fatal(err)
			}
			name := "unexpected.txt"
			if scenario == "traversal" {
				name = "../escape"
			}
			archive := writeRawZip(t, t.TempDir(), "payload.zip", map[string][]byte{name: []byte("bad")})
			data, err := os.ReadFile(archive)
			if err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256(data)
			engine := &Engine{locate: func() (Target, error) {
				return Target{Path: filepath.Join(root, appBundleName), Platform: "darwin-arm64"}, nil
			}, helper: func(HelperRequest) error { t.Error("must not start helper"); return nil }}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if scenario == "canceled" {
				cancel()
			}
			err = engine.prepareAndStartHelper(ctx, &stagedUpdate{archive: archive, platform: "darwin-arm64", artifact: PlatformArtifact{Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])}})
			if err == nil {
				t.Fatal("invalid preparation accepted")
			}
			if scenario == "canceled" && publicInstallError(err) != ErrPreparationTimeout.Error() {
				t.Fatalf("err=%v", err)
			}
			entries, err := os.ReadDir(root)
			if err != nil || len(entries) != 1 || entries[0].Name() != appBundleName {
				t.Fatalf("left temporary payload: %v %v", entries, err)
			}
			old, err := os.ReadFile(filepath.Join(root, appBundleName, "Contents", "MacOS", "BeefTV"))
			if err != nil || !strings.Contains(string(old), "OLD") {
				t.Fatal("old application changed")
			}
		})
	}
}

// Measures the removed full extraction, keeping the same per-file Sync policy.
// This is a local synthetic comparison, not a Windows device benchmark.
func BenchmarkUpdateExtraction(b *testing.B) {
	files := make(map[string][]byte, 2000)
	for i := range 2000 {
		files[fmt.Sprintf("agent-host/module-%04d.js", i)] = []byte(strings.Repeat("module.exports = {};\n", 20))
	}
	archive := filepath.Join(b.TempDir(), "update.zip")
	if err := WriteZip(archive, files, nil); err != nil {
		b.Fatal(err)
	}
	for _, passes := range []int{2, 1} {
		b.Run(fmt.Sprintf("%d-pass", passes), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				b.StopTimer()
				root := b.TempDir()
				b.StartTimer()
				for pass := range passes {
					if err := extractSecureZip(archive, filepath.Join(root, fmt.Sprint(pass)), defaultExtractLimits()); err != nil {
						b.Fatal(err)
					}
				}
			}
		})
	}
}
