//go:build !darwin && !linux && !windows

package environment

import "errors"

func freeBytes(string) (uint64, error) { return 0, errors.New("unsupported platform") }
