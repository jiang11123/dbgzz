//go:build windows

package assistantruntime

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

func configureHostProcess(cmd *exec.Cmd) {
	// The host remains supervised through stdin and keeps its diagnostic handles,
	// but a GUI launch must not allocate a separate Node console.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
}
