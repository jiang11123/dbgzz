package depthruntime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestManifestReachesThirdSignedSourceAfterTwoStalls(t *testing.T) {
	signed, public := signedTestManifest(t, Manifest{Version: 2, Runtimes: map[string]Artifact{"windows-amd64/cpu": {URLs: []string{"https://example.test/cpu.zip"}, Size: 2, SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}})
	var stalled, verified atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/github" {
			stalled.Add(1)
			<-r.Context().Done()
			return
		}
		verified.Add(1)
		_, _ = w.Write(signed)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	manifest, err := fetchManifestSources(ctx, EnsureOptions{Platform: "windows-amd64", ManifestURL: server.URL + "/cos", ManifestMirrors: []string{server.URL + "/r2", server.URL + "/github"}, TrustedPublicKey: public})
	if err != nil || manifest.Version != 2 || stalled.Load() != 2 || verified.Load() != 1 {
		t.Fatalf("third mirror = %+v, %v; hits %d/%d", manifest, err, stalled.Load(), verified.Load())
	}
}

func TestManifestMirrorsKeepWindowsSignatureVerification(t *testing.T) {
	signed, public := signedTestManifest(t, Manifest{Version: 2, Runtimes: map[string]Artifact{"windows-amd64/cpu": {URLs: []string{"https://example.test/cpu.zip"}, Size: 2, SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}})
	for _, primaryBody := range []string{`not json`, `{"version":2}`} {
		var backups atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/primary" {
				_, _ = w.Write([]byte(primaryBody))
				return
			}
			backups.Add(1)
			_, _ = w.Write(signed)
		}))
		got, err := fetchManifestSources(context.Background(), EnsureOptions{Platform: "windows-amd64", ManifestURL: server.URL + "/primary", ManifestMirrors: []string{server.URL + "/backup"}, TrustedPublicKey: public})
		server.Close()
		if err != nil || got.Version != 2 || backups.Load() != 1 {
			t.Fatalf("signed fallback = %+v, %v; hits %d", got, err, backups.Load())
		}
	}
}

func TestCancelledManifestDoesNotVisitBackup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var backups atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/primary" {
			cancel()
			<-r.Context().Done()
			return
		}
		backups.Add(1)
	}))
	defer server.Close()
	defer cancel()
	_, err := fetchManifestSources(ctx, EnsureOptions{ManifestURL: server.URL + "/primary", ManifestMirrors: []string{server.URL + "/backup"}})
	if !errors.Is(err, context.Canceled) || backups.Load() != 0 {
		t.Fatalf("cancelled metadata = %v; backup hits %d", err, backups.Load())
	}
}
