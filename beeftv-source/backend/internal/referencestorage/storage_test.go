package referencestorage

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigEncryptedAndSecretRetained(t *testing.T) {
	dir := t.TempDir()
	config := Config{AccessKeyID: "fixture-access", SecretAccessKey: "fixture-private-secret", Region: "auto"}
	public, err := Save(dir, config)
	if err != nil {
		t.Fatal(err)
	}
	if !public.HasSecret {
		t.Fatal("secret state absent")
	}
	body, err := os.ReadFile(filepath.Join(dir, "reference-storage.json"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(body, []byte(config.SecretAccessKey)) || bytes.Contains(body, []byte(config.AccessKeyID)) {
		t.Fatal("plaintext credentials written")
	}
	config.SecretAccessKey = ""
	if _, err = Save(dir, config); err != nil {
		t.Fatal(err)
	}
	restored, err := Load(dir)
	if err != nil || restored.SecretAccessKey != "fixture-private-secret" {
		t.Fatal("restart/blank field lost secret")
	}
	config.AccessKeyID = "different-access"
	if _, err = Save(dir, config); err == nil {
		t.Fatal("disabled config accepted mismatched credentials")
	}
	restored, err = Load(dir)
	if err != nil || restored.AccessKeyID != "fixture-access" {
		t.Fatal("rejected edit changed saved credentials")
	}
}

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestUploadSignsPUTAndRequiresAnonymousReadableMedia(t *testing.T) {
	path := filepath.Join(t.TempDir(), "media")
	content := []byte("same-prefix-correct-media")
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	config := Config{Enabled: true, Endpoint: "https://s3.example.com", Bucket: "fixture", Region: "auto", AccessKeyID: "access", SecretAccessKey: "secret", PublicBaseURL: "https://cdn.example.com"}
	for _, mode := range []string{"success", "private", "wrong-file"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				status := http.StatusOK
				body := content
				if calls == 1 {
					if r.Method != http.MethodPut || !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=access/") {
						t.Fatal("unsigned upload")
					}
					value, _ := io.ReadAll(r.Body)
					if !bytes.Equal(value, content) {
						t.Fatal("wrong upload bytes")
					}
				} else {
					if r.Method != http.MethodGet || r.Header.Get("Authorization") != "" || r.Header.Get("Range") != "bytes=0-511" {
						t.Fatal("public check used credentials or wrong method")
					}
					if mode == "private" {
						status = 403
					}
					if mode == "wrong-file" {
						body = []byte("same-prefix-incorrect-media")
					}
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header), Request: r}, nil
			})}
			link, err := upload(context.Background(), config, path, client)
			if mode == "success" {
				if err != nil || !strings.HasPrefix(link, config.PublicBaseURL+"/beeftv/references/") {
					t.Fatalf("upload %q %v", link, err)
				}
			} else if err == nil {
				t.Fatal("accepted unreadable/wrong media")
			}
			if value, _ := os.ReadFile(path); !bytes.Equal(value, content) {
				t.Fatal("source modified")
			}
		})
	}
}

func TestConfigRefusesPrivateURLs(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	for _, address := range []string{"http://cdn.example.com", "http://127.0.0.1:9000", "https://127.0.0.1", "https://10.0.0.1", "https://user:secret@example.com", "https://example.com?token=secret"} {
		config := Config{Endpoint: address, PublicBaseURL: address, Bucket: "fixture", Region: "auto", AccessKeyID: "access", SecretAccessKey: "secret"}
		if err := config.Validate(); err == nil {
			t.Fatalf("accepted unsafe storage URL %s", address)
		}
	}
}

func TestConfigAllowsLocalHTTPWhenPrivateUpstreamsEnabled(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, address := range []string{"http://127.0.0.1:9000", "http://10.0.0.1", "http://172.16.0.2:9000", "http://192.168.1.10:9000", "http://100.64.0.1:9000", "http://[::1]:9000", "https://10.0.0.1"} {
		config := Config{Endpoint: address, PublicBaseURL: address, Bucket: "fixture", Region: "auto", AccessKeyID: "access", SecretAccessKey: "secret"}
		if err := config.Validate(); err != nil {
			t.Fatalf("rejected local storage URL %s: %v", address, err)
		}
	}
	for _, address := range []string{"http://1.1.1.1", "http://169.254.169.254", "http://user:secret@10.0.0.1", "http://10.0.0.1?token=secret", "http://198.18.0.1:9000"} {
		config := Config{Endpoint: address, PublicBaseURL: address, Bucket: "fixture", Region: "auto", AccessKeyID: "access", SecretAccessKey: "secret"}
		if err := config.Validate(); err == nil {
			t.Fatalf("accepted unsafe storage URL %s", address)
		}
	}
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	config := Config{Endpoint: "http://127.0.0.1:9000", PublicBaseURL: "http://127.0.0.1:9000", Bucket: "fixture", Region: "auto", AccessKeyID: "access", SecretAccessKey: "secret"}
	if err := config.Validate(); err == nil {
		t.Fatal("strict mode accepted allowlisted loopback HTTP")
	}
}
