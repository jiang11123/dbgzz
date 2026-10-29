package kernel

import (
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
)

func TestDiskFullErrorPreservesCauseWithoutPath(t *testing.T) {
	for _, cause := range []error{&os.PathError{Op: "write", Path: "/private/user/video", Err: syscall.ENOSPC}, errors.New("There is not enough space on the disk"), errors.New("database or disk is full")} {
		got := DiskFullError(cause)
		if got == nil || got.Reason != "local_disk_full" || got.Cause != cause || strings.Contains(got.Message, "/private") {
			t.Fatalf("wrong mapping: %#v", got)
		}
	}
	if DiskFullError(os.ErrPermission) != nil {
		t.Fatal("permission error misclassified")
	}
}
