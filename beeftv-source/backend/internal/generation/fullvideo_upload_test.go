package generation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fullvideoReaderResources struct {
	ResourcePort
	data []byte
	t    *testing.T
}

func TestFullVideoSignedAssetOrigin(t *testing.T) {
	base := "https://video.example.com/v1"
	for _, host := range []string{"video.example.com", "assets.example.com"} {
		if !trustedFullVideoAssetSource(base, "https://"+host+"/v1/media/assets/fixture?signature=test", "https://assets.example.com") {
			t.Fatal("provider signed asset rejected", host)
		}
	}
	for _, source := range []string{
		"https://assets.example.com.evil.example/v1/media/assets/fixture",
		"https://other.example.com/v1/media/assets/fixture",
		"https://assets.example.com:444/v1/media/assets/fixture",
		"http://assets.example.com/v1/media/assets/fixture",
		"https://user@assets.example.com/v1/media/assets/fixture",
		"https://assets.example.com/other",
	} {
		if trustedFullVideoAssetSource(base, source, "https://assets.example.com") {
			t.Fatal("unexpected asset origin accepted", source)
		}
	}
	if trustedFullVideoAssetSource("https://unrelated.example", "https://assets.example.com/v1/media/assets/fixture", "") {
		t.Fatal("unrelated service inherited FullVideo media origin")
	}
	for _, origin := range []string{"", "http://assets.example.com", "https://assets.example.com/path", "https://user@assets.example.com", "https://assets.example.com?key=value", "https://assets.example.com:444"} {
		if trustedFullVideoAssetSource(base, "https://assets.example.com/v1/media/assets/fixture", origin) {
			t.Fatal("invalid configured asset origin accepted")
		}
	}
}

func TestFullVideoPrivateAssetOrigin(t *testing.T) {
	base := "https://video.example.com/v1"
	origin := "http://10.0.0.8:9000"
	source := "http://10.0.0.8:9000/v1/media/assets/fixture?signature=test"
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	if !trustedFullVideoAssetSource(base, source, origin) {
		t.Fatal("configured private HTTP origin rejected")
	}
	if !trustedFullVideoAssetSource(base, "https://10.0.0.8:9443/v1/media/assets/fixture", "https://10.0.0.8:9443") {
		t.Fatal("configured private non-443 HTTPS origin rejected")
	}
	if !trustedFullVideoAssetSource(base, "http://[::1]:9000/v1/media/assets/fixture", "http://[::1]:9000") {
		t.Fatal("configured loopback HTTP origin rejected")
	}
	for _, source := range []string{
		"http://10.0.0.9:9000/v1/media/assets/fixture",
		"https://10.0.0.8:9000/v1/media/assets/fixture",
		"http://10.0.0.8/v1/media/assets/fixture",
		"http://user@10.0.0.8:9000/v1/media/assets/fixture",
	} {
		if trustedFullVideoAssetSource(base, source, origin) {
			t.Fatal("private origin accepted a different source", source)
		}
	}
	if trustedFullVideoAssetSource(base, source, "") {
		t.Fatal("empty origin accepted a LAN URL")
	}
	if trustedFullVideoAssetSource(base, "http://169.254.169.254/v1/media/assets/fixture", "http://169.254.169.254") {
		t.Fatal("metadata origin accepted")
	}
	if trustedFullVideoAssetSource(base, "http://1.1.1.1/v1/media/assets/fixture", "http://1.1.1.1") {
		t.Fatal("public HTTP origin accepted")
	}
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	if trustedFullVideoAssetSource(base, source, origin) {
		t.Fatal("strict mode accepted private HTTP origin")
	}
	if trustedFullVideoAssetSource(base, "https://10.0.0.8:9443/v1/media/assets/fixture", "https://10.0.0.8:9443") {
		t.Fatal("strict mode accepted non-443 private HTTPS")
	}
	if !trustedFullVideoAssetSource(base, "https://assets.example.com/v1/media/assets/fixture", "https://assets.example.com") {
		t.Fatal("public https origin rejected in strict mode")
	}
	if !trustedFullVideoAssetSource("http://10.0.0.8:8080/v1", "http://10.0.0.8:8080/v1/media/assets/fixture", "") {
		t.Fatal("same-host HTTP should stay allowed without a configured origin")
	}
}

func (r fullvideoReaderResources) Open(userID, resourceID string) (ResourceInfo, io.ReadCloser, error) {
	if userID != "owner" || resourceID != "audio" {
		r.t.Fatal("resource ownership was not forwarded")
	}
	return ResourceInfo{MimeType: "audio/wav"}, io.NopCloser(bytes.NewReader(r.data)), nil
}

func TestFullVideoOwnedAudioPreservesMoreThanLegacy15MiB(t *testing.T) {
	data := bytes.Repeat([]byte{42}, (16<<20)+17)
	ctx := WithRuntime(context.Background(), Runtime{Resources: fullvideoReaderResources{data: data, t: t}})
	for _, declared := range []int64{0, int64(len(data))} {
		got, mime, skip, err := ownedFullVideoMediaReader(ctx, "owner")("audio", Media{StorageKey: "resource:audio", Bytes: declared})
		if err != nil || skip || mime != "audio/wav" || !bytes.Equal(got, data) {
			t.Fatalf("audio was rejected or truncated: got=%d err=%v", len(got), err)
		}
	}
	if _, _, _, err := ownedFullVideoMediaReader(ctx, "owner")("audio", Media{StorageKey: "resource:audio", Bytes: 100_000_001}); err == nil {
		t.Fatal("oversize audio must fail before opening the resource")
	}
}

func TestFullVideoUploadPreservesBytesAndVerifiesReceipt(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, bad := range []string{"", "hash", "origin", "incomplete", "chunk", "partial-complete", "invalid-json", "invalid-chunk-index", "dot-id", "newline-id", "second-reference"} {
		t.Run(bad, func(t *testing.T) {
			data := []byte("local reference bytes")
			sum := sha256.Sum256(data)
			digest := hex.EncodeToString(sum[:])
			var uploaded []byte
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer fixture-key" {
					t.Error("missing upload authorization")
				}
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.Method == "PUT":
					if bad == "dot-id" || bad == "newline-id" {
						t.Error("invalid upload ID reached chunk transport")
					}
					if bad == "chunk" {
						http.Error(w, "upload failed", 500)
						return
					}
					b, _ := io.ReadAll(r.Body)
					uploaded = append(uploaded, b...)
					w.Write([]byte(`{}`))
				case strings.HasSuffix(r.URL.Path, "/complete"):
					if bad == "partial-complete" {
						_, _ = w.Write([]byte(`{"status":"complete"}`))
						return
					}
					if bad == "invalid-json" {
						_, _ = w.Write([]byte(`not json`))
						return
					}
					h := digest
					if bad == "hash" {
						h = "invalid"
					}
					source := "https://" + strings.TrimPrefix(server.URL, "http://") + "/v1/media/assets/fixture?signature=test"
					if bad == "origin" {
						source = "https://different.example/v1/media/assets/fixture"
					}
					status := "complete"
					if bad == "incomplete" {
						status = "uploading"
					}
					json.NewEncoder(w).Encode(fullvideoUpload{ID: "fixture", Status: status, Kind: "video", MIME: "video/mp4", Bytes: int64(len(data)), SHA256: h, Source: source, Duration: 3})
				default:
					initial := fullvideoUpload{ID: "fixture", Status: "uploading", ChunkSize: 7}
					if bad == "dot-id" {
						initial.ID = ".."
					}
					if bad == "newline-id" {
						initial.ID = "bad\nname"
					}
					if bad == "partial-complete" {
						initial.Kind, initial.MIME, initial.Bytes, initial.SHA256, initial.Duration = "video", "video/mp4", int64(len(data)), digest, 3
						initial.Source = "https://" + strings.TrimPrefix(server.URL, "http://") + "/v1/media/assets/fixture"
					}
					if bad == "invalid-chunk-index" {
						initial.Received = []int{-1, 100}
					}
					json.NewEncoder(w).Encode(initial)
				}
			}))
			defer server.Close()
			input := Input{Mode: "video", Config: Config{BaseURL: server.URL, APIKey: "fixture-key", InterfaceType: "full-video", Model: "sd-native-full-2.5"}, ReferenceVideos: []Media{{StorageKey: "resource:owned"}}}
			if bad == "second-reference" {
				input.ReferenceVideos = append(input.ReferenceVideos, Media{StorageKey: "resource:second"})
			}
			err := prepareFullVideoReferences(context.Background(), &input, func(kind string, m Media) ([]byte, string, bool, error) {
				if m.StorageKey == "resource:second" {
					return nil, "", false, errors.New("second reference unavailable")
				}
				return data, "video/mp4", false, nil
			})
			if bad != "" {
				if err == nil {
					t.Fatal("invalid upload accepted")
				}
				if input.ReferenceVideos[0].StorageKey == "" {
					t.Fatal("failed upload replaced input")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if string(uploaded) != string(data) {
				t.Fatal("upload bytes changed")
			}
			if input.ReferenceVideos[0].DurationMs != 3000 || input.ReferenceVideos[0].StorageKey != "" {
				t.Fatal("verified metadata not applied")
			}
		})
	}
}
