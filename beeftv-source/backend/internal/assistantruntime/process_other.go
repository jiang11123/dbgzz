//go:build !windows

package assistantruntime

import "os/exec"

func configureHostProcess(*exec.Cmd) {}
