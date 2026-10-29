package desktopupdate

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var stableVersion = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var gitSHA = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)
var sha256Hex = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

type versionTriple struct {
	major int
	minor int
	patch int
}

func parseStableVersion(value string) (versionTriple, error) {
	value = strings.TrimSpace(value)
	match := stableVersion.FindStringSubmatch(value)
	if match == nil {
		return versionTriple{}, fmt.Errorf("版本号无效")
	}
	major, a := strconv.Atoi(match[1])
	minor, b := strconv.Atoi(match[2])
	patch, c := strconv.Atoi(match[3])
	if a != nil || b != nil || c != nil {
		return versionTriple{}, fmt.Errorf("版本号无效")
	}
	return versionTriple{major: major, minor: minor, patch: patch}, nil
}

func compareStable(current, latest string) (int, error) {
	latestTriple, err := parseStableVersion(latest)
	if err != nil {
		return 0, err
	}
	currentTriple, err := parseStableVersion(current)
	if err != nil {
		// Non-release builds (dev) may move forward onto a published tag.
		return -1, nil
	}
	return compareTriple(currentTriple, latestTriple), nil
}

func compareTriple(current, latest versionTriple) int {
	switch {
	case current.major < latest.major:
		return -1
	case current.major > latest.major:
		return 1
	case current.minor < latest.minor:
		return -1
	case current.minor > latest.minor:
		return 1
	case current.patch < latest.patch:
		return -1
	case current.patch > latest.patch:
		return 1
	default:
		return 0
	}
}
