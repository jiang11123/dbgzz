//go:build windows

package asset

import (
	"errors"
	"os"
	"syscall"
)

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	err = directory.Sync()
	if isIgnorableWindowsDirectorySyncError(err) {
		return nil
	}
	return err
}

// Go's os.File.Sync on a directory opened for reading calls FlushFileBuffers.
// That flush returns ERROR_ACCESS_DENIED for this kind of directory handle.
// Ignore only that Sync PathError after Open succeeded. Open, Stat, and other
// errno values still fail. This is a Go directory-handle flush compatibility
// boundary, not an NTFS durability guarantee.
func isIgnorableWindowsDirectorySyncError(err error) bool {
	var pathErr *os.PathError
	if !errors.As(err, &pathErr) {
		return false
	}
	if pathErr.Op != "sync" {
		return false
	}
	return errors.Is(pathErr.Err, syscall.ERROR_ACCESS_DENIED)
}
