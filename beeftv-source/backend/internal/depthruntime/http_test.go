package depthruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestDepthDownloadsUseDesktopProxy(t *testing.T) {
	requests := 0
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Host != "depth-download.invalid" {
			t.Errorf("proxy target %s", r.URL)
		}
		if r.URL.Path == "/manifest" {
			_, _ = w.Write([]byte(`{"version":1}`))
			return
		}
		_, _ = w.Write([]byte("runtime"))
	}))
	defer proxy.Close()
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"} {
		t.Setenv(name, proxy.URL)
	}
	for _, name := range []string{"NO_PROXY", "no_proxy"} {
		t.Setenv(name, "")
	}
	if _, err := fetchManifest(context.Background(), "http://depth-download.invalid/manifest", false, nil); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("runtime"))
	artifact := Artifact{URLs: []string{"http://depth-download.invalid/runtime"}, Size: 7, SHA256: hex.EncodeToString(hash[:])}
	if err := Download(context.Background(), artifact, filepath.Join(t.TempDir(), "runtime.zip"), nil); err != nil {
		t.Fatal(err)
	}
	if requests != 2 {
		t.Fatalf("proxy requests=%d", requests)
	}
}
