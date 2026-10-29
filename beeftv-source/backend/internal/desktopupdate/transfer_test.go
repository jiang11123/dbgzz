package desktopupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math/rand"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type transferFixture struct {
	engine  *Engine
	zip     []byte
	sum     string
	root    string
	dataDir string
	mu      sync.Mutex
	ranges  []string
}

func TestVerifyDownloadedFileSyncsValidArchive(t *testing.T) {
	body := []byte("complete downloaded archive")
	sum := sha256.Sum256(body)
	path := filepath.Join(t.TempDir(), "archive.part")
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	artifact := PlatformArtifact{Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:])}
	if err := verifyDownloadedFile(path, artifact); err != nil {
		t.Fatalf("sync verified download: %v", err)
	}
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), len(body)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyDownloadedFile(path, artifact); !errors.Is(err, ErrTampered) {
		t.Fatalf("corrupt archive accepted: %v", err)
	}
}

func (f *transferFixture) requestedRanges() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.ranges...)
}

func (f *transferFixture) partial() string {
	return filepath.Join(f.root, "downloads", f.sum+".part")
}

// newTransferFixture serves a signed feed and hands every archive request to
// serve with its 1-based call number.
func newTransferFixture(t *testing.T, idle time.Duration, serve func(w http.ResponseWriter, r *http.Request, zip []byte, call int)) *transferFixture {
	t.Helper()
	pub, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	files, execFiles := DarwinZipFiles("NEW")
	padding := make([]byte, 384*1024)
	rand.New(rand.NewSource(7)).Read(padding)
	files["BeefTV.app/Contents/Resources/padding.bin"] = padding
	zipPath := filepath.Join(t.TempDir(), "app.zip")
	if err := WriteZip(zipPath, files, execFiles); err != nil {
		t.Fatal(err)
	}
	zipBytes, err := os.ReadFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(zipBytes)
	f := &transferFixture{zip: zipBytes, sum: hex.EncodeToString(digest[:]), root: t.TempDir(), dataDir: t.TempDir()}
	calls := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/desktop-update.json":
			payload := testPayload("v1.6.0", "darwin-arm64", "", f.sum, int64(len(zipBytes)), "")
			body, err := SignEnvelope(priv, rewriteArtifactURL(payload, r.Host, zipBytes, digest[:]))
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			_, _ = w.Write(body)
		case "/BeefTV.zip":
			f.mu.Lock()
			calls++
			call := calls
			f.ranges = append(f.ranges, r.Header.Get("Range"))
			f.mu.Unlock()
			serve(w, r, zipBytes, call)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	f.engine = NewWithOptions(Options{
		CurrentVersion: "v1.5.1",
		DataDir:        f.dataDir,
		FeedURL:        server.URL + "/desktop-update.json",
		PublicKey:      pub,
		Platform:       "darwin-arm64",
		Client:         server.Client(),
		StagingRoot:    f.root,
		IdleTimeout:    idle,
		RetryBackoff:   func(int) time.Duration { return 10 * time.Millisecond },
	})
	if _, err := f.engine.CheckForUpdate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return f
}

func serveRange(w http.ResponseWriter, r *http.Request, zip []byte) {
	http.ServeContent(w, r, "BeefTV.zip", time.Time{}, bytes.NewReader(zip))
}

func abortAfter(w http.ResponseWriter, body []byte, n int) {
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body[:n])
	w.(http.Flusher).Flush()
	panic(http.ErrAbortHandler)
}

func requireReady(t *testing.T, f *transferFixture) UpdateState {
	t.Helper()
	state, err := f.engine.DownloadUpdate(context.Background())
	if err != nil {
		t.Fatalf("download: %v (state %+v)", err, state)
	}
	if state.Status != StatusReady || state.DownloadedBytes != int64(len(f.zip)) || state.Reconnecting {
		t.Fatalf("state = %+v", state)
	}
	if _, err := os.Stat(f.partial()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial file left behind: %v", err)
	}
	return state
}

func TestDownloadResumesAfterConnectionDrop(t *testing.T) {
	half := 0
	f := newTransferFixture(t, 5*time.Second, func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
		if call == 1 {
			half = len(zip) / 2
			abortAfter(w, zip, half)
		}
		serveRange(w, r, zip)
	})
	requireReady(t, f)
	ranges := f.requestedRanges()
	if len(ranges) != 2 || ranges[0] != "" || ranges[1] != "bytes="+strconv.Itoa(half)+"-" {
		t.Fatalf("ranges = %q, want resume from %d", ranges, half)
	}
	logData, err := os.ReadFile(filepath.Join(f.dataDir, logFileName))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(logData), "download attempt=1 failed") || !strings.Contains(string(logData), "download complete") {
		t.Fatalf("log = %s", logData)
	}
}

func TestDownloadContinuesPartialFromEarlierSession(t *testing.T) {
	f := newTransferFixture(t, 5*time.Second, func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
		serveRange(w, r, zip)
	})
	if err := os.MkdirAll(filepath.Dir(f.partial()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.partial(), f.zip[:1000], 0o600); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(filepath.Dir(f.partial()), strings.Repeat("a", 64)+".part")
	if err := os.WriteFile(stale, []byte("old release"), 0o600); err != nil {
		t.Fatal(err)
	}
	requireReady(t, f)
	if ranges := f.requestedRanges(); len(ranges) != 1 || ranges[0] != "bytes=1000-" {
		t.Fatalf("ranges = %q", ranges)
	}
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("partial of a superseded release was kept")
	}
}

func TestDownloadRestartsWhenServerIgnoresRange(t *testing.T) {
	f := newTransferFixture(t, 5*time.Second, func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
		_, _ = w.Write(zip)
	})
	if err := os.MkdirAll(filepath.Dir(f.partial()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.partial(), []byte("stale bytes that are not a prefix"), 0o600); err != nil {
		t.Fatal(err)
	}
	requireReady(t, f)
}

func TestDownloadRestartsOnceWhenResumedBytesAreCorrupt(t *testing.T) {
	f := newTransferFixture(t, 5*time.Second, func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
		serveRange(w, r, zip)
	})
	if err := os.MkdirAll(filepath.Dir(f.partial()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.partial(), bytes.Repeat([]byte{0xAA}, 2048), 0o600); err != nil {
		t.Fatal(err)
	}
	requireReady(t, f)
	if ranges := f.requestedRanges(); len(ranges) != 2 || ranges[0] != "bytes=2048-" || ranges[1] != "" {
		t.Fatalf("ranges = %q", ranges)
	}
}

func TestDownloadIdleTimeoutReconnectsButSlowLinkSurvives(t *testing.T) {
	t.Run("stall", func(t *testing.T) {
		f := newTransferFixture(t, 150*time.Millisecond, func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
			if call == 1 {
				w.Header().Set("Content-Length", strconv.Itoa(len(zip)))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(zip[:4096])
				w.(http.Flusher).Flush()
				select {
				case <-r.Context().Done():
				case <-time.After(5 * time.Second):
				}
				return
			}
			serveRange(w, r, zip)
		})
		requireReady(t, f)
		if ranges := f.requestedRanges(); len(ranges) != 2 || ranges[1] != "bytes=4096-" {
			t.Fatalf("ranges = %q", ranges)
		}
	})
	t.Run("slow", func(t *testing.T) {
		f := newTransferFixture(t, 150*time.Millisecond, func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
			w.Header().Set("Content-Length", strconv.Itoa(len(zip)))
			w.WriteHeader(http.StatusOK)
			chunk := len(zip)/12 + 1
			for i := 0; i < len(zip); i += chunk {
				end := min(i+chunk, len(zip))
				_, _ = w.Write(zip[i:end])
				w.(http.Flusher).Flush()
				time.Sleep(60 * time.Millisecond)
			}
		})
		started := time.Now()
		requireReady(t, f)
		if time.Since(started) < 4*150*time.Millisecond {
			t.Fatal("transfer finished faster than the idle window; test does not prove the absence of a total deadline")
		}
		if ranges := f.requestedRanges(); len(ranges) != 1 {
			t.Fatalf("slow but steady link reconnected: %q", ranges)
		}
	})
}

func TestDownloadGivesUpKeepingPartialThenContinues(t *testing.T) {
	var broken = true
	var mu sync.Mutex
	f := newTransferFixture(t, 5*time.Second, func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
		mu.Lock()
		fail := broken
		mu.Unlock()
		if call == 1 {
			abortAfter(w, zip, 8192)
		}
		if fail {
			http.Error(w, "busy", http.StatusServiceUnavailable)
			return
		}
		serveRange(w, r, zip)
	})
	state, err := f.engine.DownloadUpdate(context.Background())
	if !errors.Is(err, ErrNetworkUnstable) {
		t.Fatalf("err = %v", err)
	}
	if state.Status != StatusError || state.DownloadedBytes != 8192 || state.Error != ErrNetworkUnstable.Error() || state.Reconnecting {
		t.Fatalf("state = %+v", state)
	}
	if info, err := os.Stat(f.partial()); err != nil || info.Size() != 8192 {
		t.Fatalf("partial = %v %v", info, err)
	}
	if got := len(f.requestedRanges()); got != downloadMaxStalls {
		t.Fatalf("requests = %d", got)
	}
	mu.Lock()
	broken = false
	mu.Unlock()
	requireReady(t, f)
	ranges := f.requestedRanges()
	if ranges[len(ranges)-1] != "bytes=8192-" {
		t.Fatalf("ranges = %q", ranges)
	}
}

func TestDownloadPermanentStatusDoesNotRetry(t *testing.T) {
	f := newTransferFixture(t, 5*time.Second, func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
		http.NotFound(w, r)
	})
	_, err := f.engine.DownloadUpdate(context.Background())
	if !errors.Is(err, ErrServerBusy) {
		t.Fatalf("err = %v", err)
	}
	if got := len(f.requestedRanges()); got != 1 {
		t.Fatalf("404 retried %d times", got)
	}
}

func TestDownloadReportsSpeedWhileTransferring(t *testing.T) {
	f := newTransferFixture(t, 5*time.Second, func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
		w.Header().Set("Content-Length", strconv.Itoa(len(zip)))
		w.WriteHeader(http.StatusOK)
		chunk := len(zip)/20 + 1
		for i := 0; i < len(zip); i += chunk {
			_, _ = w.Write(zip[i:min(i+chunk, len(zip))])
			w.(http.Flusher).Flush()
			time.Sleep(80 * time.Millisecond)
		}
	})
	done := make(chan error, 1)
	go func() { _, err := f.engine.DownloadUpdate(context.Background()); done <- err }()
	var sawRate bool
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !sawRate {
		state := f.engine.Status()
		sawRate = state.Status == StatusDownloading && state.BytesPerSecond > 0
		time.Sleep(20 * time.Millisecond)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !sawRate {
		t.Fatal("no download speed reported")
	}
	if state := f.engine.Status(); state.BytesPerSecond != 0 {
		t.Fatalf("speed after completion = %+v", state)
	}
}

func TestClassifyTransportErrors(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deadProxy := listener.Addr().String()
	_ = listener.Close()
	proxyURL, _ := url.Parse("http://" + deadProxy)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
	_, err = client.Get("https://updates.invalid/desktop-update.json")
	if err == nil {
		t.Fatal("expected proxy failure")
	}
	if got := classifyTransportError(err, false); !errors.Is(got, ErrProxyUnavailable) || isRetryable(got) {
		t.Fatalf("proxy: %v retry=%v", got, isRetryable(got))
	}
	if got := classifyTransportError(context.DeadlineExceeded, false); !errors.Is(got, ErrTimeout) || !isRetryable(got) {
		t.Fatalf("timeout: %v", got)
	}
	if got := classifyTransportError(context.Canceled, true); !errors.Is(got, ErrTimeout) || !isRetryable(got) {
		t.Fatalf("idle: %v", got)
	}
	if got := classifyTransportError(&net.DNSError{Err: "no such host", Name: "updates.invalid"}, false); !errors.Is(got, ErrNetworkOffline) {
		t.Fatalf("dns: %v", got)
	}
	if got := classifyTransportError(errors.New("read: connection reset by peer"), false); !errors.Is(got, ErrConnectionDropped) || !isRetryable(got) {
		t.Fatalf("reset: %v", got)
	}
	if got := classifyStatus(http.StatusBadGateway); !isRetryable(got) {
		t.Fatal("502 should retry")
	}
	if got := classifyStatus(http.StatusForbidden); isRetryable(got) {
		t.Fatal("403 should not retry")
	}
	if msg := publicError(failure(ErrProxyUnavailable, errors.New("proxyconnect tcp: dial"), false)); msg != ErrProxyUnavailable.Error() {
		t.Fatalf("public = %q", msg)
	}
}

func TestContentRangeMustMatchResumeOffset(t *testing.T) {
	cases := map[string]bool{
		"bytes 100-999/1000": true,
		"bytes 0-999/1000":   false,
		"bytes 100-998/1000": false,
		"bytes 100-999/*":    false,
		"items 100-999/1000": false,
		"":                   false,
	}
	for header, want := range cases {
		if got := contentRangeStartsAt(header, 100, 1000); got != want {
			t.Fatalf("%q = %v", header, got)
		}
	}
}

func TestRateMeterIgnoresStaleSamples(t *testing.T) {
	var m rateMeter
	start := time.Unix(1000, 0)
	m.add(start, 0)
	m.add(start.Add(time.Second), 1000)
	if got := m.current(start.Add(time.Second)); got != 1000 {
		t.Fatalf("rate = %d", got)
	}
	if got := m.current(start.Add(time.Second + rateStaleAfter + time.Millisecond)); got != 0 {
		t.Fatalf("stale rate = %d", got)
	}
}

func TestDownloadResumesAfterCleanChunkedEOF(t *testing.T) {
	f := newTransferFixture(t, 5*time.Second, func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
		if call == 1 {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			_, _ = w.Write(zip[:8192])
			return
		}
		serveRange(w, r, zip)
	})
	requireReady(t, f)
	if ranges := f.requestedRanges(); len(ranges) != 2 || ranges[1] != "bytes=8192-" {
		t.Fatalf("ranges = %q", ranges)
	}
}

func TestDownloadParentCancellationDoesNotRetry(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := newTransferFixture(t, 5*time.Second, func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
		w.Header().Set("Content-Length", strconv.Itoa(len(zip)))
		_, _ = w.Write(zip[:8192])
		w.(http.Flusher).Flush()
		cancel()
		<-r.Context().Done()
	})
	_, err := f.engine.DownloadUpdate(ctx)
	if errors.Is(err, ErrTimeout) || len(f.requestedRanges()) != 1 {
		t.Fatalf("cancellation retried or timed out: %v ranges=%v", err, f.requestedRanges())
	}
}

func TestUpdateLogRedactsTransportURLs(t *testing.T) {
	e := &Engine{logPath: filepath.Join(t.TempDir(), "update.log"), currentVersion: "test"}
	e.logf("failed: %v", &url.Error{Op: "Get", URL: "https://user:private-password@updates.example/private-path?token=private-token#private-fragment", Err: errors.New("proxy socks5://proxy-user:proxy-password@proxy.example:1080")})
	data, err := os.ReadFile(e.logPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"user", "private-", "token=", "proxy-password"} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("log retained secret %q", secret)
		}
	}
	if !strings.Contains(string(data), "updates.example") {
		t.Fatal("log lost destination host")
	}
}
