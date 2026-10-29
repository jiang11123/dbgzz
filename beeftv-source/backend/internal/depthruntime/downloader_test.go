package depthruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestIdleDownloadPreservesPartialAndDistinguishesCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "20")
		_, _ = w.Write([]byte("prefix"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	for _, cancelled := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		path := filepath.Join(t.TempDir(), "partial")
		err := downloadSourceWithIdleTimeout(ctx, server.URL, path, 20, func(Progress) {
			if cancelled {
				cancel()
			}
		}, 40*time.Millisecond)
		cancel()
		if cancelled && (!errors.Is(err, context.Canceled) || errors.Is(err, errDownloadStalled)) {
			t.Fatalf("user cancellation = %v", err)
		}
		if !cancelled && !errors.Is(err, errDownloadStalled) {
			t.Fatalf("idle error = %v", err)
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil || string(data) != "prefix" {
			t.Fatalf("partial = %q, %v", data, readErr)
		}
	}
}

type mirrorRoundTripper func(*http.Request) (*http.Response, error)

func (f mirrorRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type stalledMirrorBody struct{ prefix bool }

func (b *stalledMirrorBody) Read(p []byte) (int, error) {
	if !b.prefix {
		b.prefix = true
		return copy(p, "prefix"), nil
	}
	return 0, errDownloadStalled
}
func (*stalledMirrorBody) Close() error { return nil }

func TestResumePublishesCompleteTemporaryFileAfterVerificationCancellation(t *testing.T) {
	payload := []byte("complete download paused before verification")
	hash := sha256.Sum256(payload)
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Range") != "" {
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	artifact := Artifact{URLs: []string{server.URL}, Size: int64(len(payload)), SHA256: hex.EncodeToString(hash[:])}
	target := filepath.Join(t.TempDir(), "runtime.zip")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := Download(ctx, artifact, target, func(progress Progress) {
		if progress.Downloaded == artifact.Size {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("pause = %v", err)
	}
	if err := Download(context.Background(), artifact, target, nil); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("complete cache caused %d requests", requests)
	}
	if err := verifyFile(target, artifact); err != nil {
		t.Fatal(err)
	}
}

func TestCompleteCorruptTemporaryFileRestartsWithoutEOFRange(t *testing.T) {
	payload := []byte("correct")
	hash := sha256.Sum256(payload)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			t.Errorf("corrupt cache resumed with %s", r.Header.Get("Range"))
		}
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	target := filepath.Join(t.TempDir(), "model")
	if err := os.WriteFile(target+".download", []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	// A previous quarantine must not block recovery of this invalid cache.
	if err := os.Mkdir(target+".corrupt", 0700); err != nil {
		t.Fatal(err)
	}
	artifact := Artifact{URLs: []string{server.URL}, Size: int64(len(payload)), SHA256: hex.EncodeToString(hash[:])}
	if err := Download(context.Background(), artifact, target, nil); err != nil {
		t.Fatal(err)
	}
	if err := verifyFile(target, artifact); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(target + ".corrupt"); err != nil || !info.IsDir() {
		t.Fatalf("previous quarantine changed: %v", err)
	}
}

func TestStalledDownloadSwitchesMirrorOnceAndResumesVerifiedBytes(t *testing.T) {
	original := downloadClient
	t.Cleanup(func() { downloadClient = original })
	primaryCalls, backupCalls := 0, 0
	downloadClient = &http.Client{Transport: mirrorRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "primary.invalid" {
			primaryCalls++
			return &http.Response{StatusCode: 200, Body: &stalledMirrorBody{}, Header: make(http.Header)}, nil
		}
		backupCalls++
		if r.Header.Get("Range") != "bytes=6-" {
			t.Errorf("mirror resume = %q", r.Header.Get("Range"))
		}
		return &http.Response{StatusCode: 206, Body: io.NopCloser(strings.NewReader(" verified")), Header: make(http.Header)}, nil
	})}
	data := []byte("prefix verified")
	hash := sha256.Sum256(data)
	target := filepath.Join(t.TempDir(), "model")
	err := Download(context.Background(), Artifact{URLs: []string{"https://primary.invalid/model", "https://backup.invalid/model"}, Size: int64(len(data)), SHA256: hex.EncodeToString(hash[:])}, target, nil)
	if err != nil || primaryCalls != 1 || backupCalls != 1 {
		t.Fatalf("download=%v calls=%d/%d", err, primaryCalls, backupCalls)
	}
	got, _ := os.ReadFile(target)
	if string(got) != string(data) {
		t.Fatalf("published = %q", got)
	}
}

func TestDownloadFallsBackAndPublishesOnlyVerifiedFile(t *testing.T) {
	payload := []byte("verified depth model")
	sum := sha256.Sum256(payload)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/primary" {
			http.Error(w, "unavailable", http.StatusBadGateway)
			return
		}
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), "models", "small.pth")
	var updates []Progress
	err := Download(context.Background(), Artifact{
		URLs: []string{server.URL + "/primary", server.URL + "/fallback"},
		Size: int64(len(payload)), SHA256: hex.EncodeToString(sum[:]),
	}, target, func(progress Progress) { updates = append(updates, progress) })
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != string(payload) {
		t.Fatalf("published file = %q, err=%v", data, err)
	}
	if len(updates) == 0 || updates[len(updates)-1].Downloaded != int64(len(payload)) {
		t.Fatalf("progress = %#v", updates)
	}
}

func TestDownloadRejectsChecksumMismatchWithoutPublishing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("corrupt")) }))
	defer server.Close()
	target := filepath.Join(t.TempDir(), "small.pth")

	err := Download(context.Background(), Artifact{URLs: []string{server.URL}, Size: 7, SHA256: string(make([]byte, 64))}, target, nil)
	if err == nil {
		t.Fatal("expected checksum error")
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Fatalf("target should not be published, stat err=%v", statErr)
	}
}

func TestDownloadRetriesAnInterruptedSourceAndResumes(t *testing.T) {
	payload := []byte("resumable verified runtime")
	sum := sha256.Sum256(payload)
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests == 1 {
			w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
			_, _ = w.Write(payload[:8])
			return
		}
		if got := r.Header.Get("Range"); got != "bytes=8-" {
			t.Errorf("range = %q", got)
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 8-%d/%d", len(payload)-1, len(payload)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(payload[8:])
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), "runtime.zip")
	err := Download(context.Background(), Artifact{URLs: []string{server.URL}, Size: int64(len(payload)), SHA256: hex.EncodeToString(sum[:])}, target, nil)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestDownloadAssemblesVerifiedReleaseParts(t *testing.T) {
	whole := []byte("three signed release chunks")
	chunks := [][]byte{whole[:8], whole[8:17], whole[17:]}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for index, part := range chunks {
			if r.URL.Path == fmt.Sprintf("/part-%d", index) {
				_, _ = w.Write(part)
				return
			}
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	parts := make([]ArtifactPart, 0, len(chunks))
	for index, part := range chunks {
		hash := sha256.Sum256(part)
		parts = append(parts, ArtifactPart{URLs: []string{fmt.Sprintf("%s/part-%d", server.URL, index)}, Size: int64(len(part)), SHA256: hex.EncodeToString(hash[:])})
	}
	wholeHash := sha256.Sum256(whole)
	target := filepath.Join(t.TempDir(), "runtime.zip")
	if err := os.WriteFile(target, []byte("stale corrupt cache"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Download(context.Background(), Artifact{Size: int64(len(whole)), SHA256: hex.EncodeToString(wholeHash[:]), Parts: parts}, target, nil); err != nil {
		t.Fatalf("assemble: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != string(whole) {
		t.Fatalf("assembled archive = %q, %v", got, err)
	}
}

func TestDownloadRejectsReleasePartWithBadHash(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("bad")) }))
	defer server.Close()
	target := filepath.Join(t.TempDir(), "runtime.zip")
	wholeHash := sha256.Sum256([]byte("good"))
	err := Download(context.Background(), Artifact{Size: 3, SHA256: hex.EncodeToString(wholeHash[:]), Parts: []ArtifactPart{{URLs: []string{server.URL}, Size: 3, SHA256: hex.EncodeToString(wholeHash[:])}}}, target, nil)
	if err == nil {
		t.Fatal("corrupt release part was accepted")
	}
	if pathExists(target) {
		t.Fatal("corrupt assembled archive was published")
	}
}

func TestDownloadRejectsAssembledArchiveWithBadHash(t *testing.T) {
	part := []byte("valid-part")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(part) }))
	defer server.Close()
	partHash := sha256.Sum256(part)
	wrongWholeHash := sha256.Sum256([]byte("different archive"))
	target := filepath.Join(t.TempDir(), "runtime.zip")
	err := Download(context.Background(), Artifact{
		Size: int64(len(part)), SHA256: hex.EncodeToString(wrongWholeHash[:]),
		Parts: []ArtifactPart{{URLs: []string{server.URL}, Size: int64(len(part)), SHA256: hex.EncodeToString(partHash[:])}},
	}, target, nil)
	if err == nil || pathExists(target) {
		t.Fatalf("bad complete archive hash was accepted: %v", err)
	}
}

func TestDownloadRejectsReleasePartsWhoseSizesDoNotAddUp(t *testing.T) {
	hash := sha256.Sum256([]byte("whole"))
	err := Download(context.Background(), Artifact{
		Size: 5, SHA256: hex.EncodeToString(hash[:]),
		Parts: []ArtifactPart{{URLs: []string{"https://example.invalid/part"}, Size: 4, SHA256: hex.EncodeToString(hash[:])}},
	}, filepath.Join(t.TempDir(), "runtime.zip"), nil)
	if err == nil {
		t.Fatal("mismatched release part total was accepted")
	}
}
