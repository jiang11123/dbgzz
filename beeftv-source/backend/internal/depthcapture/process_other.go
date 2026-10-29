//go:build !windows

package depthcapture

import "os/exec"

func configureDepthCommand(_ *exec.Cmd) {}
