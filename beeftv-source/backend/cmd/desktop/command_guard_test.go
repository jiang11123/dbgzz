package main

import "testing"

func TestDesktopRejectsCLICommands(t *testing.T) {
	for _, args := range [][]string{{"mcp", "serve"}, {"ops", "--json"}, {"canvas", "get"}, {"client", "register"}, {"unknown-command"}, {"--json", "mcp", "serve"}} {
		if err := validateDesktopArgs(args); err == nil {
			t.Fatalf("desktop accepted CLI arguments %v", args)
		}
	}
	for _, args := range [][]string{nil, {"-psn_0_12345"}, {"--disable-gpu"}, {"--user-data-dir=platform-profile"}, {"-NSDocumentRevisionsDebugMode", "YES"}, {"-AppleLanguages", "(en)"}} {
		if err := validateDesktopArgs(args); err != nil {
			t.Fatalf("desktop rejected platform arguments %v: %v", args, err)
		}
	}
}
