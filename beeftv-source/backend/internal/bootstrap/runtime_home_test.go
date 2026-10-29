package bootstrap

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMain(m *testing.M) {
	if runtime.GOOS != "windows" {
		os.Exit(m.Run())
	}
	originalHome, err := os.UserHomeDir()
	if err != nil {
		panic(err)
	}
	// Keep Go's default module cache while isolating Windows runtime descriptors.
	if os.Getenv("GOPATH") == "" {
		if err := os.Setenv("GOPATH", filepath.Join(originalHome, "go")); err != nil {
			panic(err)
		}
	}
	home, err := os.MkdirTemp("", "beeftv-bootstrap-home-")
	if err != nil {
		panic(err)
	}
	if err := os.Setenv("USERPROFILE", home); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(home)
	os.Exit(code)
}
