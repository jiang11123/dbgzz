package app

import (
	"context"
	"errors"
	"net"
	"net/url"
	"os"
	"syscall"
	"testing"
)

func TestWindowsVideoConnectionResetRecovery(t *testing.T) {
	for _, code := range []syscall.Errno{syscall.WSAECONNRESET, syscall.WSAECONNABORTED} {
		err := &url.Error{Op: "Get", URL: "https://example.invalid/task/original", Err: &net.OpError{Op: "read", Net: "tcp", Err: &os.SyscallError{Syscall: "wsarecv", Err: code}}}
		t.Run(code.Error(), func(t *testing.T) {
			attempts := 0
			result, got := runVideoPollLoop(context.Background(), "original", fastVideoPollPolicy(), func(context.Context) (videoPollOutcome, error) {
				attempts++
				if attempts == 1 {
					return videoPollOutcome{}, err
				}
				return videoPollOutcome{Done: true, Result: map[string]interface{}{"task": "original"}}, nil
			})
			if got != nil || attempts != 2 || result["task"] != "original" {
				t.Fatalf("attempts=%d result=%v error=%v", attempts, result, got)
			}
			if !retryableProtocolMediaDownload(err) {
				t.Fatal("media download cannot recover Windows disconnect")
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if retry, _ := retryableVideoPollError(ctx, err); retry {
				t.Fatal("cancelled query retried")
			}
			if retry, _ := retryableVideoPollError(context.Background(), errors.New("permanent error")); retry {
				t.Fatal("permanent error retried")
			}
		})
	}
}
