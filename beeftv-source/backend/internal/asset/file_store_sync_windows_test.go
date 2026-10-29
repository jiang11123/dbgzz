//go:build windows

package asset

import (
	"fmt"
	"os"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
)

func TestSyncDirectoryAcceptsWindowsDirectoryHandle(t *testing.T) {
	dir := t.TempDir()
	if err := syncDirectory(dir); err != nil {
		t.Fatalf("Windows directory Sync must not fail with Access is denied: %v", err)
	}
}

func TestIgnorableWindowsDirectorySyncErrorOnlySyncAccessDenied(t *testing.T) {
	syncDenied := &os.PathError{Op: "sync", Path: `C:\Users\Administrator\AppData\Local\Temp\resources`, Err: syscall.ERROR_ACCESS_DENIED}
	if !isIgnorableWindowsDirectorySyncError(syncDenied) {
		t.Fatal("PathError Op=sync ACCESS_DENIED from directory FlushFileBuffers may be ignored")
	}
	if !isIgnorableWindowsDirectorySyncError(fmt.Errorf("sync local resource directory: %w", syncDenied)) {
		t.Fatal("wrapped Op=sync ACCESS_DENIED must still be recognized")
	}

	openDenied := &os.PathError{Op: "open", Path: `C:\Users\Administrator\AppData\Local\Temp\resources`, Err: syscall.ERROR_ACCESS_DENIED}
	if isIgnorableWindowsDirectorySyncError(openDenied) {
		t.Fatal("PathError Op=open ACCESS_DENIED must be preserved")
	}
	if isIgnorableWindowsDirectorySyncError(fmt.Errorf("sync local resource directory: %w", openDenied)) {
		t.Fatal("wrapped Op=open ACCESS_DENIED must be preserved")
	}

	statDenied := &os.PathError{Op: "stat", Path: `C:\Users\Administrator\AppData\Local\Temp\resources`, Err: syscall.ERROR_ACCESS_DENIED}
	if isIgnorableWindowsDirectorySyncError(statDenied) {
		t.Fatal("PathError Op=stat ACCESS_DENIED must be preserved")
	}
	if isIgnorableWindowsDirectorySyncError(&os.PathError{Op: "sync", Path: `C:\Users\Administrator\AppData\Local\Temp\resources`, Err: windows.ERROR_INVALID_HANDLE}) {
		t.Fatal("Op=sync ERROR_INVALID_HANDLE must not be ignored")
	}
	if isIgnorableWindowsDirectorySyncError(syscall.ERROR_ACCESS_DENIED) {
		t.Fatal("bare ACCESS_DENIED without a sync PathError must not be ignored")
	}
	if isIgnorableWindowsDirectorySyncError(os.ErrPermission) {
		t.Fatal("generic permission errors must not be ignored")
	}
	if isIgnorableWindowsDirectorySyncError(nil) {
		t.Fatal("nil error is not ignorable")
	}
}
