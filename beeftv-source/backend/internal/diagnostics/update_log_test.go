package diagnostics

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestUpdateLogWindowRotationAndPrivacy(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 10, 15, 8, 0, 0, 0, time.UTC)
	line := func(offset time.Duration, message string) string {
		return now.Add(offset).Format(time.RFC3339) + " v1.7.20 " + message + "\n"
	}
	previous := line(-time.Minute, "update phase=extracting") + line(-time.Hour, "update phase=downloading")
	current := line(0, "install failure phase=extracting completedFiles=34 totalFiles=15000 timeout=true") +
		line(0, `install preparation failed: open C:\Users\private-user\secret.zip: permission denied token=private-token`) +
		line(0, "download start size=123 resumeFrom=10 route=proxy private-host:1080") +
		line(0, "download attempt=2 failed: connection reset private-host") +
		line(time.Hour, "update phase=restarting") +
		line(0, "unrecognized private-payload")
	for name, data := range map[string]string{"update.log.1": previous, "update.log": current} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	window := timeWindow{From: now.Add(-2 * time.Minute), To: now}
	log := collectUpdateLog(dir, window)
	if log.Status != "available" || log.Lines != 5 {
		t.Fatalf("%+v", log)
	}
	for _, forbidden := range []string{"private", "secret", "downloading", "restarting", "token="} {
		if strings.Contains(log.Text, forbidden) {
			t.Fatalf("leaked %s: %s", forbidden, log.Text)
		}
	}
	if !strings.Contains(log.Text, "permission-denied") || !strings.Contains(log.Text, "completedFiles=34") {
		t.Fatal(log.Text)
	}
	data, err := buildZIP("BeefTV", "test", manifest{}, &collection{Window: window, UpdateLog: log})
	if err != nil {
		t.Fatal(err)
	}
	files := readTestZIP(t, data)
	if files["desktop/update.log"] != log.Text || !strings.Contains(files["desktop/update-log.json"], `"lines": 5`) {
		t.Fatal(files)
	}
}

func TestUpdateLogMissingUnreadableAndBounded(t *testing.T) {
	dir := t.TempDir()
	window := timeWindow{From: time.Now().Add(-time.Hour), To: time.Now().Add(time.Hour)}
	if collectUpdateLog("", window) != nil || collectUpdateLog(dir, window).Status != "missing" {
		t.Fatal("missing log should not fail export")
	}
	path := filepath.Join(dir, "update.log")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if collectUpdateLog(dir, window).Status != "unreadable" {
		t.Fatal("non-regular log accepted")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	line := time.Now().UTC().Format(time.RFC3339) + " v1.7.20 update phase=extracting\n"
	if err := os.WriteFile(path, []byte(strings.Repeat(line, 10000)), 0600); err != nil {
		t.Fatal(err)
	}
	log := collectUpdateLog(dir, window)
	if !log.Truncated || log.Lines == 0 || len(log.Text) > updateLogLimit {
		t.Fatalf("%+v", log)
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("private", updateLogLimit)+"\n"+line), 0600); err != nil {
		t.Fatal(err)
	}
	log = collectUpdateLog(dir, window)
	if !log.Truncated || log.Text != line || log.Lines != 1 {
		t.Fatalf("lost line after oversized error: %+v", log)
	}
}
