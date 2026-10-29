package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

func cmdChangelog(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("changelog", stderr)
	file := fs.String("file", "", "path to CHANGELOG.md")
	version := fs.String("version", "", "stable version heading such as v1.6.0")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*file) == "" {
		return fmt.Errorf("changelog requires --file")
	}
	notes, err := extractChangelogNotes(*file, *version)
	if err != nil {
		return err
	}
	_, err = io.WriteString(stdout, notes)
	if !strings.HasSuffix(notes, "\n") && err == nil {
		_, err = io.WriteString(stdout, "\n")
	}
	return err
}

func extractChangelogNotes(path, versionText string) (string, error) {
	version, err := parseStableVersion(versionText)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read changelog: %w", err)
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	heading := "## " + version.String()
	lines := strings.Split(text, "\n")
	var collected []string
	found := false
	for _, line := range lines {
		if !found {
			if line == heading {
				found = true
			}
			continue
		}
		if strings.HasPrefix(line, "## ") {
			break
		}
		collected = append(collected, line)
	}
	if !found {
		return "", fmt.Errorf("CHANGELOG.md is missing heading %s", heading)
	}
	notes := strings.TrimSpace(strings.Join(collected, "\n"))
	if notes == "" {
		return "", fmt.Errorf("CHANGELOG.md heading %s has no release notes", heading)
	}
	return notes, nil
}
