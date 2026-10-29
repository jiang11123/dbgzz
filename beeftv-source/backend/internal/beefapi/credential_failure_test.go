package beefapi

import (
	"errors"
	"infinite-canvas/backend/internal/kernel"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveKeepsSafeLocalCredentialFailure(t *testing.T) {
	for _, mode := range []string{"missing", "short", "mismatch"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			encrypted, err := encryptSecret(dir, "private-test-credential")
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, ".settings-key")
			if mode == "missing" {
				err = os.Remove(path)
			} else {
				key := []byte("short")
				if mode == "mismatch" {
					key = make([]byte, 32)
				}
				err = os.WriteFile(path, key, 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			s := &Service{dataDir: dir, state: persistedState{EncryptedAPIKey: encrypted}}
			_, err = s.Resolve()
			var appErr *kernel.AppError
			if !errors.As(err, &appErr) || appErr.Status != 500 || appErr.Reason != "local_credential_failed" || appErr.Cause == nil {
				t.Fatalf("lost cause: %v", err)
			}
			if strings.Contains(err.Error(), dir) || strings.Contains(err.Error(), "private-test-credential") || !strings.Contains(err.Error(), "凭据读取失败") {
				t.Fatalf("unsafe or unclear: %v", err)
			}
		})
	}
}
