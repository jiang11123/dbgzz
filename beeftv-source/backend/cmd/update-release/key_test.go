package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGenKeyWritesPrivateFileAndOmitsPrivateMaterial(t *testing.T) {
	dir := t.TempDir()
	privatePath := filepath.Join(dir, "updater.private")
	publicPath := filepath.Join(dir, "updater.public")
	var stdout, stderr bytes.Buffer
	if err := run([]string{"gen-key", "--private-key", privatePath, "--public-key", publicPath}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	privateBytes, err := os.ReadFile(privatePath)
	if err != nil {
		t.Fatal(err)
	}
	publicBytes, err := os.ReadFile(publicPath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(privatePath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("private key mode %o, want 0600", info.Mode().Perm())
		}
	}
	privateText := strings.TrimSpace(string(privateBytes))
	publicText := strings.TrimSpace(string(publicBytes))
	if privateText == "" || publicText == "" {
		t.Fatal("key files must not be empty")
	}
	if bytes.Contains(stdout.Bytes(), []byte(privateText)) || bytes.Contains(stderr.Bytes(), []byte(privateText)) {
		t.Fatal("private key material was written to stdout or stderr")
	}
	rawPrivate, err := base64.StdEncoding.DecodeString(privateText)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stdout.Bytes(), rawPrivate) || bytes.Contains(stderr.Bytes(), rawPrivate) {
		t.Fatal("raw private key bytes were written to stdout or stderr")
	}
	if !strings.Contains(stdout.String(), "public_key="+publicText) {
		t.Fatalf("stdout should report public key, got %q", stdout.String())
	}
	private, err := parsePrivateKey(privateText)
	if err != nil {
		t.Fatal(err)
	}
	public, err := parsePublicKey(publicText)
	if err != nil {
		t.Fatal(err)
	}
	if !derivedPublicEquals(private, public) {
		t.Fatal("generated public key does not match private key")
	}
	if err := run([]string{"gen-key", "--private-key", privatePath}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("expected overwrite of private key to fail")
	}
}

func TestGenKeyRequiresExplicitPrivatePath(t *testing.T) {
	err := run([]string{"gen-key"}, ioDiscard{}, ioDiscard{})
	if err == nil || !strings.Contains(err.Error(), "refusing to write a private key to the terminal") {
		t.Fatalf("expected explicit file requirement, got %v", err)
	}
}

func TestParsePrivateKeyAcceptsSeedAndRejectsMismatch(t *testing.T) {
	_, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	seedKey, err := parsePrivateKey(encodeKey(private.Seed()))
	if err != nil {
		t.Fatal(err)
	}
	fullKey, err := parsePrivateKey(encodeKey(private))
	if err != nil {
		t.Fatal(err)
	}
	if !seedKey.Equal(fullKey) {
		t.Fatal("seed and 64-byte private key should derive the same key")
	}
	tampered := append([]byte{}, private...)
	tampered[len(tampered)-1] ^= 0xff
	if _, err := parsePrivateKey(encodeKey(tampered)); err == nil {
		t.Fatal("expected mismatched public half to fail")
	}
	if _, err := parsePrivateKey(encodeKey([]byte("short"))); err == nil {
		t.Fatal("expected short key to fail")
	}
	if _, err := parsePublicKey("%%%"); err == nil {
		t.Fatal("expected invalid public key base64 to fail")
	}
}

func TestPublicKeyCommandReadsEnv(t *testing.T) {
	_, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(privateKeyEnv, encodeKey(private))
	var stdout bytes.Buffer
	if err := run([]string{"public-key"}, &stdout, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	got := strings.TrimSpace(stdout.String())
	want := encodeKey(private.Public().(ed25519.PublicKey))
	if got != want {
		t.Fatalf("public key %s, want %s", got, want)
	}
}
