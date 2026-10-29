package desktopupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/desktopnet"
)

func newHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = desktopnet.Proxy
	transport.TLSHandshakeTimeout = 15 * time.Second
	transport.ResponseHeaderTimeout = 30 * time.Second
	return &http.Client{
		Transport:     transport,
		CheckRedirect: httpsRedirects,
	}
}

func httpsRedirects(req *http.Request, via []*http.Request) error {
	if len(via) >= maxRedirects {
		return fmt.Errorf("重定向次数过多")
	}
	if req.URL == nil || req.URL.Scheme != "https" || req.URL.Host == "" {
		return errInsecureUpdateURL
	}
	return nil
}

func (e *Engine) fetchFeed(ctx context.Context) (Payload, error) {
	var data []byte
	err := e.retry(ctx, actionCheck, feedMaxStalls, func() (bool, error) {
		var err error
		data, err = e.getBytes(ctx, e.feedURL, maxFeedBytes, e.feedTimeout)
		return false, err
	})
	if err != nil {
		return Payload{}, err
	}
	payload, _, err := verifyEnvelope(data, e.publicKey)
	if err != nil {
		return Payload{}, err
	}
	return payload, nil
}

func (e *Engine) getBytes(ctx context.Context, rawURL string, maxBytes int64, timeout time.Duration) ([]byte, error) {
	if _, err := normalizeFeedURL(rawURL); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "BeefTV-Desktop-Updater/"+e.currentVersion)
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, classifyTransportError(err, false)
	}
	defer resp.Body.Close()
	if resp.TLS == nil {
		return nil, errInsecureUpdateURL
	}
	if resp.StatusCode != http.StatusOK {
		return nil, classifyStatus(resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, classifyTransportError(err, false)
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("更新信息过大")
	}
	return data, nil
}

// downloadArchive keeps the bytes it has already received in a per-hash
// partial file, so a retry, a later click, or an app restart continues where
// the link dropped. Integrity never depends on the transfer: the complete file
// is hashed against the signed manifest before it is moved into staging.
func (e *Engine) downloadArchive(ctx context.Context, artifact PlatformArtifact, dest string) error {
	if _, err := normalizeFeedURL(artifact.URL); err != nil {
		return err
	}
	partial, err := e.partialPath(artifact)
	if err != nil {
		return err
	}
	started := time.Now()
	restarted := false
	for {
		e.setPhase("downloading")
		resumedFrom, err := e.fetchPartial(ctx, artifact, partial)
		if err != nil {
			return err
		}
		e.setPhase("verifying")
		if err := verifyDownloadedFile(partial, artifact); err != nil {
			_ = os.Remove(partial)
			e.setProgress(0)
			// A resumed tail can only be wrong if the earlier bytes were; one
			// clean download from zero tells the two cases apart.
			if resumedFrom > 0 && !restarted {
				e.logf("download resumed file failed verification, restarting from zero")
				restarted = true
				continue
			}
			return err
		}
		e.logf("download complete bytes=%d resumedFrom=%d elapsed=%s", artifact.Size, resumedFrom, time.Since(started).Round(time.Second))
		return os.Rename(partial, dest)
	}
}

func (e *Engine) fetchPartial(ctx context.Context, artifact PlatformArtifact, path string) (int64, error) {
	offset, err := partialSize(path, artifact.Size)
	if err != nil {
		return 0, err
	}
	resumedFrom := offset
	e.setProgress(offset)
	e.logf("download start size=%d resumeFrom=%d route=%s", artifact.Size, offset, e.route(artifact.URL))
	err = e.retry(ctx, actionDownload, downloadMaxStalls, func() (bool, error) {
		if offset >= artifact.Size {
			return false, nil
		}
		before := offset
		next, err := e.fetchRange(ctx, artifact, path, offset)
		offset = next
		return offset > before, err
	})
	if err != nil && isRetryable(err) && offset > 0 {
		return resumedFrom, failure(ErrNetworkUnstable, rawCause(err), true)
	}
	return resumedFrom, err
}

func (e *Engine) fetchRange(ctx context.Context, artifact PlatformArtifact, path string, offset int64) (int64, error) {
	reqCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	watch := watchIdle(e.idleTimeout, cancel)
	defer watch.stop()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, artifact.URL, nil)
	if err != nil {
		return offset, err
	}
	req.Header.Set("User-Agent", "BeefTV-Desktop-Updater/"+e.currentVersion)
	if offset > 0 {
		req.Header.Set("Range", "bytes="+strconv.FormatInt(offset, 10)+"-")
	}
	resp, err := e.client.Do(req)
	if err != nil {
		return offset, classifyTransportError(err, watch.fired())
	}
	defer resp.Body.Close()
	if resp.TLS == nil {
		return offset, errInsecureUpdateURL
	}
	switch resp.StatusCode {
	case http.StatusPartialContent:
		if offset == 0 || !contentRangeStartsAt(resp.Header.Get("Content-Range"), offset, artifact.Size) {
			if err := truncatePartial(path); err != nil {
				return 0, err
			}
			e.setProgress(0)
			return 0, failure(ErrConnectionDropped, fmt.Errorf("unexpected Content-Range %q", resp.Header.Get("Content-Range")), true)
		}
	case http.StatusOK:
		if resp.ContentLength > 0 && resp.ContentLength != artifact.Size {
			return offset, ErrTampered
		}
		offset = 0
		e.setProgress(0)
	case http.StatusRequestedRangeNotSatisfiable:
		if err := truncatePartial(path); err != nil {
			return 0, err
		}
		e.setProgress(0)
		return 0, failure(ErrConnectionDropped, errors.New("HTTP 416"), true)
	default:
		return offset, classifyStatus(resp.StatusCode)
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return offset, err
	}
	if err := file.Truncate(offset); err != nil {
		_ = file.Close()
		return offset, err
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		_ = file.Close()
		return offset, err
	}
	remaining := artifact.Size - offset
	body := io.LimitReader(resp.Body, remaining+1)
	buf := make([]byte, 64*1024)
	var readErr error
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if offset+int64(n) > artifact.Size {
				_ = file.Close()
				_ = os.Remove(path)
				return 0, ErrTampered
			}
			if _, werr := file.Write(buf[:n]); werr != nil {
				_ = file.Close()
				return offset, werr
			}
			offset += int64(n)
			watch.touch()
			e.addDownloaded(int64(n))
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				readErr = err
			}
			break
		}
	}
	if err := file.Close(); err != nil {
		return offset, err
	}
	if readErr != nil {
		return offset, classifyTransportError(readErr, watch.fired())
	}
	if offset < artifact.Size {
		// A chunked response can end cleanly before all signed bytes arrive.
		// Keep its prefix for retry; only the final size/hash authorizes use.
		return offset, failure(ErrConnectionDropped, io.ErrUnexpectedEOF, true)
	}
	return offset, nil
}

func contentRangeStartsAt(header string, offset, size int64) bool {
	header = strings.TrimSpace(header)
	unit, rest, ok := strings.Cut(header, " ")
	if !ok || unit != "bytes" {
		return false
	}
	span, total, ok := strings.Cut(rest, "/")
	if !ok || total != strconv.FormatInt(size, 10) {
		return false
	}
	first, last, ok := strings.Cut(span, "-")
	if !ok {
		return false
	}
	start, err := strconv.ParseInt(first, 10, 64)
	if err != nil || start != offset {
		return false
	}
	end, err := strconv.ParseInt(last, 10, 64)
	return err == nil && end == size-1
}

func (e *Engine) partialPath(artifact PlatformArtifact) (string, error) {
	root, err := e.updatesRoot()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, "downloads")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	name := strings.ToLower(strings.TrimSpace(artifact.SHA256)) + ".part"
	// Only one artifact can be current; partial files for superseded
	// releases would otherwise accumulate at ~150 MB each.
	if entries, err := os.ReadDir(dir); err == nil {
		for _, entry := range entries {
			if entry.Name() != name && strings.HasSuffix(entry.Name(), ".part") && entry.Type().IsRegular() {
				_ = os.Remove(filepath.Join(dir, entry.Name()))
			}
		}
	}
	return filepath.Join(dir, name), nil
}

func partialSize(path string, size int64) (int64, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if !info.Mode().IsRegular() {
		if err := os.RemoveAll(path); err != nil {
			return 0, err
		}
		return 0, nil
	}
	if info.Size() > size {
		return 0, truncatePartial(path)
	}
	return info.Size(), nil
}

func truncatePartial(path string) error {
	err := os.Truncate(path, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func verifyDownloadedFile(path string, artifact PlatformArtifact) error {
	// Windows FlushFileBuffers requires a writable handle even after hashing.
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	hasher := sha256.New()
	written, err := io.Copy(hasher, io.LimitReader(file, artifact.Size+1))
	if err != nil {
		return err
	}
	if written != artifact.Size {
		return ErrTampered
	}
	if !strings.EqualFold(hex.EncodeToString(hasher.Sum(nil)), strings.TrimSpace(artifact.SHA256)) {
		return ErrTampered
	}
	return file.Sync()
}

// idleWatch cancels a transfer only when no bytes arrive for the whole idle
// window. A total deadline would abort slow but healthy links.
type idleWatch struct {
	mu        sync.Mutex
	timer     *time.Timer
	window    time.Duration
	lastReset time.Time
	didFire   bool
}

func watchIdle(window time.Duration, cancel context.CancelFunc) *idleWatch {
	w := &idleWatch{window: window, lastReset: time.Now()}
	w.timer = time.AfterFunc(window, func() {
		w.mu.Lock()
		w.didFire = true
		w.mu.Unlock()
		cancel()
	})
	return w
}

func (w *idleWatch) touch() {
	now := time.Now()
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.didFire || now.Sub(w.lastReset) < w.window/8 {
		return
	}
	w.lastReset = now
	w.timer.Reset(w.window)
}

func (w *idleWatch) fired() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.didFire
}

func (w *idleWatch) stop() {
	w.timer.Stop()
}
