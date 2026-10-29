package diagnostics

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const updateLogLimit = 256 * 1024

type updateLogSummary struct {
	Status    string `json:"status"`
	Lines     int    `json:"lines"`
	Truncated bool   `json:"truncated"`
	Text      string `json:"-"`
}

// Only known diagnostic fields leave the machine. Raw OS errors can contain
// usernames, paths and credentials, even in an otherwise URL-redacted log.
var safeUpdateMessage = regexp.MustCompile(`^(update phase=(downloading|verifying|extracting|preparing|restarting)|download complete bytes=[0-9]+ resumedFrom=[0-9]+ elapsed=[0-9.hmsµ]+|install preparation elapsed=[0-9.hmsµ]+|install prepared version=v?[0-9.]+; requesting exit|install failure phase=[a-z]+ completedFiles=[0-9]+ totalFiles=[0-9]+ timeout=(true|false)|download resumed file failed verification, restarting from zero)$`)
var safeUpdateVersion = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$`)
var updateDownloadStart = regexp.MustCompile(`^download start size=([0-9]+) resumeFrom=([0-9]+) route=(direct|custom-client|unknown|proxy-error|proxy)(?: |$)`)
var updateAttemptFailure = regexp.MustCompile(`^(check|download) attempt=([0-9]+) failed: `)

func collectUpdateLog(dir string, window timeWindow) *updateLogSummary {
	if dir == "" {
		return nil
	}
	result := &updateLogSummary{Status: "missing"}
	var output strings.Builder
	for _, name := range []string{"update.log.1", "update.log"} {
		path := filepath.Join(dir, name)
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() {
			result.Status = "unreadable"
			continue
		}
		file, err := os.Open(path)
		if err != nil {
			result.Status = "unreadable"
			continue
		}
		if result.Status != "unreadable" {
			result.Status = "available"
		}
		start := max(int64(0), info.Size()-updateLogLimit)
		_, err = file.Seek(start, io.SeekStart)
		if err != nil {
			file.Close()
			result.Status = "unreadable"
			continue
		}
		reader := bufio.NewScanner(io.LimitReader(file, updateLogLimit))
		reader.Buffer(make([]byte, 4096), updateLogLimit)
		if start > 0 {
			result.Truncated = true
			reader.Scan()
		}
		for reader.Scan() {
			parts := strings.SplitN(reader.Text(), " ", 3)
			if len(parts) != 3 || !safeUpdateVersion.MatchString(parts[1]) {
				continue
			}
			stamp, err := time.Parse(time.RFC3339, parts[0])
			if err != nil || stamp.Before(window.From) || stamp.After(window.To) {
				continue
			}
			message := parts[2]
			if !safeUpdateMessage.MatchString(message) {
				if match := updateDownloadStart.FindStringSubmatch(message); match != nil {
					message = "download start size=" + match[1] + " resumeFrom=" + match[2] + " route=" + match[3]
				} else {
					message = summarizeUpdateFailure(message)
				}
			}
			if message == "" {
				continue
			}
			output.WriteString(stamp.UTC().Format(time.RFC3339) + " " + parts[1] + " " + message + "\n")
			result.Lines++
		}
		if reader.Err() != nil {
			result.Truncated = true
		}
		file.Close()
	}
	result.Text = output.String()
	return result
}

func summarizeUpdateFailure(message string) string {
	stage := ""
	if match := updateAttemptFailure.FindStringSubmatch(message); match != nil {
		stage = match[1] + " attempt=" + match[2] + " failed"
	}
	for _, prefix := range []string{"check failed", "download failed", "install preparation failed", "install quit failed", "install helper stopped"} {
		if strings.HasPrefix(message, prefix+":") || strings.HasPrefix(message, prefix+" route=") {
			stage = prefix
			break
		}
	}
	if stage == "" {
		return ""
	}
	reason := "details-redacted"
	lower := strings.ToLower(message)
	for _, item := range []struct{ marker, code string }{
		{"超时", "timeout"}, {"deadline exceeded", "timeout"}, {"timeout", "timeout"},
		{"no space left", "disk-full"}, {"not enough space", "disk-full"},
		{"permission denied", "permission-denied"}, {"access is denied", "permission-denied"},
		{"connection reset", "connection-reset"}, {"connection refused", "connection-refused"},
		{"文件损坏", "verification-failed"},
	} {
		if strings.Contains(lower, item.marker) {
			reason = item.code
			break
		}
	}
	return stage + ": " + reason
}
