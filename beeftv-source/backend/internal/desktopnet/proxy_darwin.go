package desktopnet

import (
	"context"
	"os/exec"
	"time"
)

func readSystemProxy() systemProxySettings {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "/usr/sbin/scutil", "--proxy").Output()
	if err != nil {
		return systemProxySettings{}
	}
	return parseMacProxy(string(output))
}
