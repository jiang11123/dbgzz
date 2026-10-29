package depthcapture

import (
	"context"
	"golang.org/x/sys/windows"
	"os/exec"
	"testing"
)

func TestDepthChildProcessesDoNotCreateConsoleWindows(t *testing.T) {
	command := exec.CommandContext(context.Background(), "python.exe", "-m", "depth_capture")
	configureDepthCommand(command)
	if command.SysProcAttr == nil || !command.SysProcAttr.HideWindow || command.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatal("depth child can create a console window")
	}
}
