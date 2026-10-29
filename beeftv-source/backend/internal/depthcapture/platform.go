package depthcapture

import "runtime"

func Supported(goos, goarch string) bool {
	if goos == "" {
		goos = runtime.GOOS
	}
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	return (goos == "darwin" && goarch == "arm64") || (goos == "windows" && goarch == "amd64")
}

func PlatformID(goos string) string {
	if goos == "windows" {
		return "windows-amd64"
	}
	return "darwin-arm64"
}
