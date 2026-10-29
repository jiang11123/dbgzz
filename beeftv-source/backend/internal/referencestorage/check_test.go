package referencestorage

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestCheckUploadsReadsAndCleansOnlyItsOwnTestObject(t *testing.T) {
	for _, mode := range []string{"success", "private", "upload-denied", "delete-denied"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			var content []byte
			var uploadedPath string
			var methods []string
			config := Config{Enabled: true, Endpoint: "https://s3.example.com", Bucket: "fixture", Region: "auto", AccessKeyID: "access", SecretAccessKey: "secret", PublicBaseURL: "https://cdn.example.com"}
			client := &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
				methods = append(methods, r.Method)
				status, body := 200, []byte(nil)
				switch r.Method {
				case http.MethodPut:
					content, _ = io.ReadAll(r.Body)
					uploadedPath = r.URL.Path
					if !bytes.HasPrefix(content, []byte("\x89PNG\r\n\x1a\n")) {
						t.Fatal("test did not use a PNG")
					}
					if mode == "upload-denied" {
						status = 403
					}
				case http.MethodGet:
					if r.Header.Get("Authorization") != "" {
						t.Fatal("read check sent credentials")
					}
					body = content
					if mode == "private" {
						status = 403
					}
				case http.MethodDelete:
					if r.URL.Path != uploadedPath || r.URL.Host != "s3.example.com" || !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
						t.Fatal("cleanup targeted another object or was unsigned")
					}
					if mode == "delete-denied" {
						status = 403
					}
				default:
					t.Fatal(r.Method)
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
			})}
			err := check(context.Background(), config, dir, client)
			if (err == nil) != (mode == "success") {
				t.Fatalf("mode %s: %v", mode, err)
			}
			if methods[0] != "PUT" || methods[len(methods)-1] != "DELETE" {
				t.Fatal(methods)
			}
			if files, _ := os.ReadDir(dir); len(files) != 0 {
				t.Fatal("local test file retained")
			}
			if err != nil && strings.Contains(err.Error(), "secret") {
				t.Fatal("error leaked credential")
			}
		})
	}
}
