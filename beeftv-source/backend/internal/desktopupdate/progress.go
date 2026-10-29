package desktopupdate

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"infinite-canvas/backend/internal/desktopnet"
)

const (
	rateWindow     = 500 * time.Millisecond
	rateStaleAfter = 3 * time.Second
	logFileName    = "update.log"
	logMaxBytes    = 256 * 1024
)

// rateMeter smooths download speed so the remaining-time estimate does not
// jump with every TCP burst. Resumed bytes are never counted as speed.
type rateMeter struct {
	windowStart time.Time
	windowBytes int64
	rate        float64
	lastByte    time.Time
}

func (m *rateMeter) add(now time.Time, n int64) {
	if m.windowStart.IsZero() {
		m.windowStart = now
	}
	m.windowBytes += n
	m.lastByte = now
	elapsed := now.Sub(m.windowStart)
	if elapsed < rateWindow {
		return
	}
	instant := float64(m.windowBytes) / elapsed.Seconds()
	if m.rate == 0 {
		m.rate = instant
	} else {
		m.rate = 0.3*instant + 0.7*m.rate
	}
	m.windowStart = now
	m.windowBytes = 0
}

func (m *rateMeter) current(now time.Time) int64 {
	if m.lastByte.IsZero() || now.Sub(m.lastByte) > rateStaleAfter {
		return 0
	}
	return int64(m.rate)
}

func (e *Engine) setProgress(downloaded int64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.state.DownloadedBytes = downloaded
	e.meter = rateMeter{}
}

func (e *Engine) addDownloaded(n int64) {
	now := time.Now()
	e.mu.Lock()
	defer e.mu.Unlock()
	e.state.DownloadedBytes += n
	if e.state.TotalBytes > 0 && e.state.DownloadedBytes > e.state.TotalBytes {
		e.state.DownloadedBytes = e.state.TotalBytes
	}
	e.state.Reconnecting = false
	e.meter.add(now, n)
}

// route records whether the request would leave through a proxy. Only the
// host is kept; proxy credentials never reach the log.
func (e *Engine) route(rawURL string) string {
	if !e.systemClient {
		return "custom-client"
	}
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return "unknown"
	}
	proxy, err := desktopnet.Proxy(req)
	if err != nil {
		return "proxy-error"
	}
	if proxy == nil {
		return "direct"
	}
	return "proxy " + proxy.Host
}

// logf appends to a small rotating file in the data directory. The UI only
// shows a short message; this keeps the real network error for support.
func (e *Engine) logf(format string, args ...any) {
	if e.logPath == "" {
		return
	}
	e.logMu.Lock()
	defer e.logMu.Unlock()
	if info, err := os.Stat(e.logPath); err == nil && info.Size() > logMaxBytes {
		_ = os.Rename(e.logPath, e.logPath+".1")
	}
	file, err := os.OpenFile(e.logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	message := logURL.ReplaceAllStringFunc(fmt.Sprintf(format, args...), func(raw string) string {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return "[redacted-url]"
		}
		return u.Scheme + "://" + u.Host
	})
	_, _ = fmt.Fprintf(file, "%s %s %s\n", time.Now().UTC().Format(time.RFC3339), e.currentVersion, message)
}

var logURL = regexp.MustCompile(`(?i)[a-z][a-z0-9+.-]*://[^\s"'<>]+`)

func updateLogPath(dataDir string) string {
	if dataDir == "" {
		return ""
	}
	return filepath.Join(dataDir, logFileName)
}
