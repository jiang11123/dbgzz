//go:build !windows

package outbound

import (
	"errors"
	"syscall"
)

// IsConnectionInterrupted recognizes native socket errors through HTTP wrappers.
func IsConnectionInterrupted(err error) bool {
	return errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNABORTED) || errors.Is(err, syscall.EPIPE)
}
