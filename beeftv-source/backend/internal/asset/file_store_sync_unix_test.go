//go:build unix

package asset

import "testing"

func TestSyncDirectoryRequiresUnixDirectoryFsync(t *testing.T) {
	dir := t.TempDir()
	if err := syncDirectory(dir); err != nil {
		t.Fatalf("unix directory fsync is required and must succeed: %v", err)
	}
}
