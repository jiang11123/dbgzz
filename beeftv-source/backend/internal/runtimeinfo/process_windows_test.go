package runtimeinfo

import (
	"os"
	"os/exec"
	"testing"
)

func TestTerminatedWindowsProcessWithOpenHandleIsNotAlive(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	// Retaining a handle keeps the process object accessible after termination.
	held, err := os.FindProcess(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if ProcessAlive(cmd.Process.Pid) {
		t.Fatal("terminated process with a retained handle reported alive")
	}
}
