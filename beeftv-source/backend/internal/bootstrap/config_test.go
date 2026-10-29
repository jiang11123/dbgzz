package bootstrap

import "testing"

func TestServerListenDefaultsToLoopback(t *testing.T) {
	got := (Config{Profile: ProfileServer}).withDefaults()
	if got.ListenAddr != DefaultServerListenAddr {
		t.Fatalf("server default listen = %q", got.ListenAddr)
	}
	if DefaultServerListenAddr != "127.0.0.1:8080" {
		t.Fatalf("loopback default changed: %q", DefaultServerListenAddr)
	}
	explicit := (Config{Profile: ProfileServer, ListenAddr: ":8080"}).withDefaults()
	if explicit.ListenAddr != ":8080" {
		t.Fatalf("explicit server listen = %q", explicit.ListenAddr)
	}
	desktop := (Config{Profile: ProfileDesktop}).withDefaults()
	if desktop.ListenAddr != "127.0.0.1:0" {
		t.Fatalf("desktop default listen = %q", desktop.ListenAddr)
	}
}
