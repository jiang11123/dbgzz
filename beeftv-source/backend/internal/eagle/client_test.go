package eagle

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeItemCollectionsKeepsEmptyArrays(t *testing.T) {
	item := &Item{}
	normalizeItemCollections(item)
	if item.FolderIDs == nil || len(item.FolderIDs) != 0 {
		t.Fatalf("folder IDs = %#v, want a non-nil empty slice", item.FolderIDs)
	}
	if item.Tags == nil || len(item.Tags) != 0 {
		t.Fatalf("tags = %#v, want a non-nil empty slice", item.Tags)
	}
}

func TestItemUnmarshalJSONUsesEagleWireNames(t *testing.T) {
	var item Item
	if err := json.Unmarshal([]byte(`{"id":"1","name":"a","ext":"PNG","folders":["f"],"tags":["t"],"isDeleted":true}`), &item); err != nil {
		t.Fatal(err)
	}
	if item.Extension != "PNG" || len(item.FolderIDs) != 1 || item.FolderIDs[0] != "f" || !item.Deleted {
		t.Fatalf("item = %#v", item)
	}
}

func TestFlattenFoldersAssignsParentAndClearsNestedChildren(t *testing.T) {
	flat := flattenFolders([]Folder{{
		ID: "root", Name: "Root", Children: []Folder{{ID: "child", Name: "Child"}},
	}}, "")
	if len(flat) != 2 || flat[0].ID != "root" || flat[0].ParentID != "" || flat[0].Children != nil || flat[1].ID != "child" || flat[1].ParentID != "root" {
		t.Fatalf("flattenFolders = %#v", flat)
	}
}

func TestClientJSONRequestTalksEagleProtocol(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/library/info":
			io.WriteString(w, `{"status":"success","data":{"applicationVersion":"4.0","library":{"path":"/lib","name":"Main"},"folders":[{"id":"a","name":"A","children":[{"id":"b","name":"B"}]}]}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/item/list":
			if r.URL.Query().Get("limit") != "60" || r.URL.Query().Get("folders") != "a" || r.URL.Query().Get("keyword") != "cat" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			io.WriteString(w, `{"status":"success","data":[{"id":"1","name":"Cat","ext":"JPG","folders":[],"tags":[]}]}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := &Client{transport: server.Client().Transport}
	base, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	var libraryResponse struct {
		Status string `json:"status"`
		Data   struct {
			Library struct {
				Name string `json:"name"`
			} `json:"library"`
		} `json:"data"`
	}
	if err := client.jsonRequest(http.MethodGet, base, "/api/library/info", nil, &libraryResponse); err != nil {
		t.Fatal(err)
	}
	if libraryResponse.Status != "success" || libraryResponse.Data.Library.Name != "Main" {
		t.Fatalf("library response = %#v", libraryResponse)
	}

	var itemsResponse struct {
		Status string `json:"status"`
		Data   []Item `json:"data"`
	}
	if err := client.jsonRequest(http.MethodGet, base, "/api/item/list?limit=60&folders=a&keyword=cat", nil, &itemsResponse); err != nil {
		t.Fatal(err)
	}
	if len(itemsResponse.Data) != 1 || itemsResponse.Data[0].Extension != "JPG" {
		t.Fatalf("items = %#v", itemsResponse.Data)
	}
}

func TestClientDoesNotFollowRedirectOffTrustedDestination(t *testing.T) {
	var secondHits int
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secondHits++
		io.WriteString(w, `{"status":"success"}`)
	}))
	defer second.Close()

	var firstHits int
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		firstHits++
		http.Redirect(w, r, second.URL+"/stolen", http.StatusFound)
	}))
	defer first.Close()

	var seen []string
	client := &Client{transport: roundTripRecorder{inner: first.Client().Transport, seen: &seen}}
	base, err := url.Parse(first.URL)
	if err != nil {
		t.Fatal(err)
	}
	var target struct {
		Status string `json:"status"`
	}
	err = client.jsonRequest(http.MethodGet, base, "/api/library/info", nil, &target)
	if err == nil || !strings.Contains(err.Error(), "HTTP 302") {
		t.Fatalf("redirect error = %v", err)
	}
	if firstHits != 1 || secondHits != 0 {
		t.Fatalf("hits first=%d second=%d, want first=1 second=0", firstHits, secondHits)
	}
	if len(seen) != 1 {
		t.Fatalf("custom transport saw %v", seen)
	}
}

func TestPinnedTransportRejectsOtherDestinationEvenWithCustomTransport(t *testing.T) {
	var called bool
	inner := roundTripFunc(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, errors.New("inner must not run")
	})
	trusted, err := url.Parse("http://127.0.0.1:41595")
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodGet, "http://example.com/api/library/info", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pinnedRoundTripper{base: inner, trusted: trusted}.RoundTrip(req)
	if err == nil || !strings.Contains(err.Error(), "已校验的本机地址") {
		t.Fatalf("pin error = %v", err)
	}
	if called {
		t.Fatal("custom transport was invoked for an untrusted destination")
	}

	local, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/library/info", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pinnedRoundTripper{base: inner, trusted: trusted}.RoundTrip(local)
	if err == nil || called {
		t.Fatalf("other local port pin error = %v called=%v", err, called)
	}
}

type roundTripRecorder struct {
	inner http.RoundTripper
	seen  *[]string
}

func (r roundTripRecorder) RoundTrip(req *http.Request) (*http.Response, error) {
	if r.seen != nil && req != nil && req.URL != nil {
		*r.seen = append(*r.seen, req.URL.String())
	}
	return r.inner.RoundTrip(req)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestClientRejectsAbsoluteOrHostedEndpoint(t *testing.T) {
	client := New()
	base, _ := url.Parse("http://127.0.0.1:41595")
	var target struct{}
	if err := client.jsonRequest(http.MethodGet, base, "https://evil.example/api", nil, &target); err == nil || !strings.Contains(err.Error(), "路径无效") {
		t.Fatalf("absolute endpoint error = %v", err)
	}
	if err := client.jsonRequest(http.MethodGet, base, "//evil.example/api", nil, &target); err == nil || !strings.Contains(err.Error(), "路径无效") {
		t.Fatalf("host endpoint error = %v", err)
	}
}

func TestOpenLocalFileServesJailedOriginal(t *testing.T) {
	root := t.TempDir()
	itemID := "open-1"
	itemDir := filepath.Join(root, "images", itemID+".info")
	if err := os.MkdirAll(itemDir, 0o750); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(itemDir, "shot.png")
	thumbnail := filepath.Join(itemDir, "shot_thumbnail.png")
	if err := os.WriteFile(original, []byte("png-bytes"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(thumbnail, []byte("thumb"), 0o640); err != nil {
		t.Fatal(err)
	}
	resolved, err := originalPath(thumbnail, itemID, root)
	if err != nil {
		t.Fatal(err)
	}
	if resolved != mustEvalSymlinks(t, original) {
		t.Fatalf("originalPath = %q, want %q", resolved, mustEvalSymlinks(t, original))
	}
	file, err := openLocalFile(resolved, "无法读取 Eagle 原始文件，请确认素材库仍处于可用状态")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Body.Close()
	body, _ := io.ReadAll(file.Body)
	if string(body) != "png-bytes" || file.Name != "shot.png" {
		t.Fatalf("opened file = %#v body=%q", file, body)
	}
}
