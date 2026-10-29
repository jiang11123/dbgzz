//go:build windows

package desktopstorage

import (
	"errors"
	"golang.org/x/sys/windows"
)

func fileInUse(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}
