//go:build !windows

package mediatools

import "os/exec"

func HideConsole(cmd *exec.Cmd) {}
