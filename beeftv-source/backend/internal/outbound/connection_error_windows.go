package outbound

import (
	"errors"
	"syscall"
)

// IsConnectionInterrupted recognizes native socket errors through HTTP wrappers.
// Winsock codes differ from Go's portable syscall.ECONNRESET constants.
func IsConnectionInterrupted(err error) bool {
	return errors.Is(err, syscall.WSAECONNRESET) || errors.Is(err, syscall.WSAECONNABORTED) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE)
}
