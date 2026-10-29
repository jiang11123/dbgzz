package buildinfo

import "testing"

func TestCurrentUsesInjectedValues(t *testing.T) {
	previousVersion, previousCommit, previousBuildTime := Version, Commit, BuildTime
	t.Cleanup(func() { Version, Commit, BuildTime = previousVersion, previousCommit, previousBuildTime })
	Version, Commit, BuildTime = " v1.2.3 ", " abc123 ", " 2026-08-30T00:00:00Z "

	info := Current()
	if info.Version != "v1.2.3" || info.Commit != "abc123" || info.BuildTime != "2026-08-30T00:00:00Z" {
		t.Fatalf("unexpected build info: %#v", info)
	}
	if info.GoVersion == "" {
		t.Fatal("Go version should be populated")
	}
}
