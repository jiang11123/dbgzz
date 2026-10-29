//go:build !windows

package desktopstorage

func fileInUse(err error) bool { return false }
