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
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

type wanReferenceResources struct {
	ResourcePort
	t    *testing.T
	data []byte
}

func (p wanReferenceResources) Lookup(user, id string) (ResourceInfo, error) {
	if user != "user-1" || id != "first-frame" {
		p.t.Fatal("resource ownership was not forwarded")
	}
	return ResourceInfo{ID: id, Kind: "image", Status: "ready", MimeType: "image/png", Size: int64(len(p.data)), Width: 720, Height: 1280}, nil
}
func (p wanReferenceResources) Open(user, id string) (ResourceInfo, io.ReadCloser, error) {
	info, err := p.Lookup(user, id)
	return info, io.NopCloser(bytes.NewReader(p.data)), err
}
func (p wanReferenceResources) LocalMode() bool { return true }
func (p wanReferenceResources) HTTPSPublicURL(ResourceInfo, time.Time) (string, error) {
	return "", errors.New("local resource")
}

// Exercise Execute and the installed JSON video plugin, not a hand-built Wan body.
// The synthetic provider ends after create so this test never polls or downloads.
func TestExecuteWanReferenceUpload(t *testing.T) {
	manifest, err := os.ReadFile("../../../plugin-packages/newapi-video-generations-v1/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	adapters, err := protocol.LoadInstalledProviders(manifest, nil)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := protocol.NewRegistry(adapters...)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"local", "inline", "remote", "remote-http", "text", "missing-upload", "unsupported-upload", "invalid-receipt", "asset", "custom-inline", "versioned-audio-false"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
			payload := bytes.Repeat([]byte("x"), 3<<20)
			digest := sha256.Sum256(payload)
			var creates, puts, completes, generates int
			var posted map[string]any
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v1/video-references/uploads":
					creates++
					if name == "missing-upload" {
						w.WriteHeader(404)
						return
					}
					if name == "unsupported-upload" {
						w.WriteHeader(501)
						return
					}
					var body BeefAPISeedanceUploadRequest
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if body.Kind != "image" || body.Bytes != int64(len(payload)) || body.SHA256 != hex.EncodeToString(digest[:]) {
						t.Errorf("wrong upload manifest: %#v", body)
					}
					_ = json.NewEncoder(w).Encode(BeefAPISeedanceUploadSession{UploadURL: server.URL + "/put", UploadMethod: "PUT", Ticket: "fixture", RequiredHeaders: map[string]string{"Content-Type": "image/png"}})
				case "/put":
					puts++
					data, _ := io.ReadAll(r.Body)
					if r.Method != "PUT" || r.Header.Get("Authorization") != "" || !bytes.Equal(data, payload) {
						t.Error("signed PUT changed bytes or leaked credentials")
					}
				case "/v1/video-references/uploads/complete":
					completes++
					sum := hex.EncodeToString(digest[:])
					if name == "invalid-receipt" {
						sum = "invalid"
					}
					_ = json.NewEncoder(w).Encode(BeefAPISeedanceUploadComplete{URL: server.URL + "/named/first-frame", Kind: "image", Mime: "image/png", Bytes: int64(len(payload)), SHA256: sum})
				case "/v1/video/generations":
					generates++
					if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
						t.Error(err)
					}
					_, _ = io.WriteString(w, `{"id":"fixture-wan","status":"failed","error":{"message":"fixture terminal"}}`)
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			runtime := taskRuntime(func(r *Runtime) {
				r.Endpoints.BeefAPIVideoBaseURL = server.URL
				r.Resources = wanReferenceResources{t: t, data: payload}
			})
			input := Input{Mode: "video", Prompt: "fixture", Config: Config{BaseURL: server.URL, APIKey: "synthetic", Model: "wan3.0-video", InterfaceType: "newapi-channel-2", VideoSeconds: "6", Size: "9:16", VQuality: "720p", VideoGenerateAudio: "true"}, ReferenceImages: []Media{{ID: "first", StorageKey: "resource:first-frame"}}}
			wantURL := server.URL + "/named/first-frame"
			if name == "inline" || name == "custom-inline" {
				input.ReferenceImages[0] = Media{ID: "first", DataURL: DataURL("image/png", payload), MimeType: "image/png"}
			}
			if name == "remote" || name == "remote-http" {
				wantURL = "https://media.example/first-frame.png"
				if name == "remote-http" {
					wantURL = "http://media.example/first-frame.png"
				}
				input.ReferenceImages[0] = Media{ID: "first", URL: wantURL}
			}
			if name == "asset" {
				input.ReferenceImages[0] = Media{ID: "first", URL: "asset://not-a-wan-reference"}
			}
			if name == "text" {
				input.ReferenceImages = nil
			}
			if name == "custom-inline" {
				runtime.Endpoints.BeefAPIVideoBaseURL = server.URL + "/different-gateway"
				input.Config.ReferenceMediaTransport = map[string]string{"image": "inline"}
				wantURL = input.ReferenceImages[0].DataURL
			}
			if name == "versioned-audio-false" {
				version := "fixture-v7"
				input.Config.VideoCapabilitiesVersion = &version
				input.Config.VideoGenerateAudio = "false"
			}
			_, err := Execute(WithProtocolRegistry(WithRuntime(context.Background(), runtime), registry), input)
			blocked := name == "missing-upload" || name == "unsupported-upload" || name == "invalid-receipt" || name == "asset"
			if blocked {
				if err == nil || generates != 0 {
					t.Fatalf("preparation failure reached video create: error=%v creates=%d", err, generates)
				}
				var preparation RequestPreparationError
				if !errors.As(err, &preparation) || ClassifyError(err).Uncertain {
					t.Fatalf("preparation lost known-not-submitted classification: %v", err)
				}
				wantCreates, wantPuts := 1, 0
				if name == "asset" {
					wantCreates = 0
				}
				if name == "invalid-receipt" {
					wantPuts = 1
				}
				if creates != wantCreates || puts != wantPuts || completes != wantPuts {
					t.Fatalf("wrong preparation boundary: %d/%d/%d", creates, puts, completes)
				}
				if (name == "missing-upload" || name == "unsupported-upload") && !strings.Contains(err.Error(), "本次尚未开始生成") {
					t.Fatalf("unclear upload failure: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), "fixture terminal") || generates != 1 {
				t.Fatalf("did not reach the official consumer once: error=%v generates=%d", err, generates)
			}
			wantUploads := 1
			if name == "remote" || name == "remote-http" || name == "text" || name == "custom-inline" {
				wantUploads = 0
			}
			if creates != wantUploads || puts != wantUploads || completes != wantUploads {
				t.Fatalf("upload counts=%d/%d/%d want %d", creates, puts, completes, wantUploads)
			}
			if posted["seconds"] != "6" || posted["aspect_ratio"] != "9:16" || posted["resolution"] != "720p" || posted["generate_audio"] != (name != "versioned-audio-false") {
				t.Fatalf("requested controls changed: %#v", posted)
			}
			if name != "text" && !reflect.DeepEqual(posted["image_urls"], []any{wantURL}) {
				t.Fatal("reference did not reach official plugin unchanged as expected")
			}
		})
	}
}
