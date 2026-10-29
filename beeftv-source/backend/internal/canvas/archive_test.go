package canvas

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/editing"
)

type archiveTestSource struct {
	body     string
	fail     bool
	declared int64
}

func (s archiveTestSource) OpenArchiveMedia(_ context.Context, id string) (ArchiveMedia, error) {
	if s.fail || id != "owned" {
		return ArchiveMedia{}, fmt.Errorf("not owned")
	}
	size := int64(len(s.body))
	if s.declared != 0 {
		size = s.declared
	}
	return ArchiveMedia{Body: io.NopCloser(strings.NewReader(s.body)), MimeType: "image/png", Bytes: size}, nil
}

func TestProjectArchiveRoundTripKeepsPortraitAndEditableSubtitle(t *testing.T) {
	var mediaBytes bytes.Buffer
	if err := png.Encode(&mediaBytes, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	const initial = `{"id":"portrait","title":"雨夜书店","nodes":[{"id":"image","type":"image","metadata":{"storageKey":"resource:owned"}}],"timeline":{"version":2,"output":{"width":720,"height":1280,"fps":24},"durationMs":1000,"tracks":[{"id":"shot","kind":"video","label":"画面","order":3},{"id":"captions","kind":"subtitle","label":"字幕","order":7}],"clips":[{"id":"clip","kind":"image","nodeId":"image","trackId":"shot","startMs":0,"durationMs":1000,"directMedia":{"id":"owned","kind":"image","storageKey":"resource:owned"}},{"id":"caption","kind":"subtitle","trackId":"captions","startMs":0,"durationMs":1000,"text":"总有一页等你翻开"}]}}`
	read := func(raw json.RawMessage) map[string]any {
		t.Helper()
		var out bytes.Buffer
		if err := WriteProjectArchive(context.Background(), &out, raw, archiveTestSource{body: mediaBytes.String()}); err != nil {
			t.Fatal(err)
		}
		if directory := os.Getenv("BEEFTV_TEST_ARCHIVE_OUTPUT_DIR"); directory != "" {
			if err := os.WriteFile(filepath.Join(directory, "portable-project.zip"), out.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
		}
		z, err := zip.NewReader(bytes.NewReader(out.Bytes()), int64(out.Len()))
		if err != nil {
			t.Fatal(err)
		}
		if len(z.File) != 2 {
			t.Fatalf("duplicate media or missing manifest: %d", len(z.File))
		}
		var doc map[string]any
		for _, file := range z.File {
			body, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(body)
			body.Close()
			if err != nil {
				t.Fatal(err)
			}
			if file.Name == "projects.json" {
				var manifest struct {
					App      string `json:"app"`
					Version  int    `json:"version"`
					Projects []struct {
						Project map[string]any `json:"project"`
						Files   []struct {
							StorageKey, Path string
							Bytes            int64
						} `json:"files"`
					} `json:"projects"`
				}
				if err := json.Unmarshal(data, &manifest); err != nil {
					t.Fatal(err)
				}
				if manifest.App != "infinite-canvas" || manifest.Version != 4 || len(manifest.Projects[0].Files) != 1 {
					t.Fatalf("bad manifest %s", data)
				}
				ref := manifest.Projects[0].Files[0]
				if ref.StorageKey != "resource:owned" || ref.Bytes != int64(mediaBytes.Len()) {
					t.Fatalf("bad ref %+v", ref)
				}
				if _, err := z.Open(ref.Path); err != nil {
					t.Fatal("unresolved media ref", err)
				}
				doc = manifest.Projects[0].Project
			} else if !bytes.Equal(data, mediaBytes.Bytes()) {
				t.Fatal("media bytes changed")
			}
		}
		return doc
	}
	doc := read(json.RawMessage(initial))
	timeline := doc["timeline"].(map[string]any)
	timeline["clips"].([]any)[1].(map[string]any)["text"] = "总有一页，等你翻开"
	raw, _ := json.Marshal(doc)
	// Reopen the saved edited project through the same ZIP format.
	doc = read(raw)
	encoded, _ := json.Marshal(doc["timeline"])
	var project editing.Project
	if err := json.Unmarshal(encoded, &project); err != nil {
		t.Fatal(err)
	}
	plan, err := editing.Compile(project, nil, editing.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Output.Width != 720 || plan.Output.Height != 1280 || plan.Output.FPS != 24 || plan.Subtitles[0].Text != "总有一页，等你翻开" {
		t.Fatalf("edit/reopen lost output or text: %+v", plan)
	}
	if project.Tracks[0].Label != "画面" || project.Tracks[0].Order == nil || *project.Tracks[0].Order != 3 || project.Tracks[1].ID != "captions" {
		t.Fatalf("track identity lost %+v", project.Tracks)
	}
}

func TestProjectArchiveFailsForUnavailableOrTruncatedSources(t *testing.T) {
	for name, source := range map[string]archiveTestSource{"foreign": {fail: true}, "truncated": {body: "bytes", declared: 100}} {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			err := WriteProjectArchive(context.Background(), &out, json.RawMessage(`{"id":"p","nodes":[{"metadata":{"storageKey":"resource:owned"}}]}`), source)
			if err == nil {
				t.Fatal("silently wrote partial archive")
			}
		})
	}
	for _, raw := range []string{`{"id":"p","metadata":{"storageKey":"image:browser"}}`, `{"id":"p","metadata":{"drawingId":"browser-only"}}`} {
		var out bytes.Buffer
		if err := WriteProjectArchive(context.Background(), &out, json.RawMessage(raw), archiveTestSource{}); err == nil {
			t.Fatal("exported unsupported browser data")
		}
	}
}
