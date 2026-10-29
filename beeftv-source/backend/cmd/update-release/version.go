package main

import (
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

var stableVersionPattern = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type stableVersion struct {
	major int
	minor int
	patch int
}

func cmdValidateVersion(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("validate-version", stderr)
	version := fs.String("version", "", "version to validate, such as v1.6.0")
	confirm := fs.String("confirm", "", "dispatch confirmation that must match --version")
	greaterThan := fs.String("greater-than", "", "optional previously published version that --version must exceed")
	if err := fs.Parse(args); err != nil {
		return err
	}
	parsed, err := parseStableVersion(*version)
	if err != nil {
		return err
	}
	if strings.TrimSpace(*confirm) != "" && strings.TrimSpace(*confirm) != parsed.String() {
		return fmt.Errorf("confirm_version %q does not match VERSION %s", strings.TrimSpace(*confirm), parsed)
	}
	if strings.TrimSpace(*greaterThan) != "" {
		previous, err := parseStableVersion(*greaterThan)
		if err != nil {
			return fmt.Errorf("latest published version: %w", err)
		}
		if parsed.compare(previous) <= 0 {
			return fmt.Errorf("%s is not newer than published %s; updater versions are immutable and cannot be republished or rolled back in place", parsed, previous)
		}
	}
	fmt.Fprintln(stdout, parsed.String())
	return nil
}

func parseStableVersion(text string) (stableVersion, error) {
	text = strings.TrimSpace(text)
	if !stableVersionPattern.MatchString(text) {
		return stableVersion{}, fmt.Errorf("VERSION %q is not a stable vMAJOR.MINOR.PATCH tag; updater releases reject prerelease labels and raw commit SHAs", text)
	}
	parts := strings.Split(text[1:], ".")
	major, _ := strconv.Atoi(parts[0])
	minor, _ := strconv.Atoi(parts[1])
	patch, _ := strconv.Atoi(parts[2])
	return stableVersion{major: major, minor: minor, patch: patch}, nil
}

func (v stableVersion) String() string {
	return fmt.Sprintf("v%d.%d.%d", v.major, v.minor, v.patch)
}

func (v stableVersion) compare(other stableVersion) int {
	switch {
	case v.major != other.major:
		return v.major - other.major
	case v.minor != other.minor:
		return v.minor - other.minor
	default:
		return v.patch - other.patch
	}
}

func parseCommitSHA(text string) (string, error) {
	text = strings.ToLower(strings.TrimSpace(text))
	if len(text) != 40 && len(text) != 64 {
		return "", fmt.Errorf("commit must be a full 40- or 64-character Git SHA")
	}
	for _, r := range text {
		hex := r >= '0' && r <= '9' || r >= 'a' && r <= 'f'
		if !hex {
			return "", fmt.Errorf("commit must be a full 40- or 64-character Git SHA")
		}
	}
	return text, nil
}
