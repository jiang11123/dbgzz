//go:build !darwin && !windows

package desktopnet

func readSystemProxy() systemProxySettings { return systemProxySettings{} }
