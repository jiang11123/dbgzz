package generation

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBeefAPIH3BodyKeepsKeyframeRolesAndResolution(t *testing.T) {
	for _, tc := range []struct {
		name        string
		images      []Media
		metadata    map[string]interface{}
		first, last string
	}{
		{"text", nil, nil, "", ""},
		{"first", []Media{{ID: "a", URL: "https://example.com/a.png"}}, nil, "https://example.com/a.png", ""},
		{"two", []Media{{ID: "a", URL: "https://example.com/a.png"}, {ID: "b", URL: "https://example.com/b.png"}}, nil, "https://example.com/a.png", "https://example.com/b.png"},
		{"end only", []Media{{ID: "b", URL: "https://example.com/b.png"}}, map[string]interface{}{"videoEndFrameNodeId": "b"}, "", "https://example.com/b.png"},
		{"explicit reordered", []Media{{ID: "b", URL: "https://example.com/b.png"}, {ID: "a", URL: "https://example.com/a.png"}}, map[string]interface{}{"videoStartFrameNodeId": "a", "videoEndFrameNodeId": "b"}, "https://example.com/a.png", "https://example.com/b.png"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, err := BeefAPIVideoRequestBody(Input{Prompt: "test", Config: Config{Model: "minimax-h3-max-turbo", VideoSeconds: "5", VQuality: "768", Size: "9:16"}, ReferenceImages: tc.images, Metadata: tc.metadata})
			if err != nil {
				t.Fatal(err)
			}
			if body["resolution"] != "768p" || body["seconds"] != "5" {
				t.Fatalf("controls lost: %#v", body)
			}
			for field, want := range map[string]string{"first_frame_url": tc.first, "last_frame_url": tc.last} {
				if got, _ := body[field].(string); got != want {
					t.Fatalf("%s=%q want %q", field, got, want)
				}
			}
			if len(tc.images) == 0 {
				if body["aspect_ratio"] != "9:16" {
					t.Fatal("ratio lost")
				}
			} else if body["aspect_ratio"] != nil {
				t.Fatal("keyframe ratio must follow image")
			}
			for _, field := range []string{"generate_audio", "watermark", "content", "image_urls"} {
				if body[field] != nil {
					t.Fatalf("unsupported %s sent", field)
				}
			}
		})
	}
}
func TestBeefAPIH3RejectsUnsupportedInputs(t *testing.T) {
	for _, input := range []Input{
		{Config: Config{Model: "minimax-h3-max-turbo", VideoSeconds: "0.91"}},
		{Config: Config{Model: "minimax-h3-max-turbo", VQuality: "720"}},
		{Config: Config{Model: "minimax-h3-max-turbo"}, ReferenceVideos: []Media{{URL: "file:///tmp/v.mp4"}}},
		{Config: Config{Model: "minimax-h3-max-turbo"}, ReferenceImages: []Media{{ID: "a", URL: "https://example.com/a.png"}}, Metadata: map[string]interface{}{"videoEndFrameNodeId": "missing"}},
	} {
		if _, err := BeefAPIVideoRequestBody(input); err == nil {
			t.Fatalf("accepted invalid input: %#v", input)
		}
	}
}
func TestBeefAPIH3DesktopTaskDownloadsGatewayVideo(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "1")
	creates, polls, downloads := 0, 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("gateway credential lost")
		}
		switch r.URL.Path {
		case "/v1/videos":
			creates++
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["model"] != "minimax-h3-max-turbo" || body["resolution"] != "768p" {
				t.Errorf("wrong body: %#v", body)
			}
			json.NewEncoder(w).Encode(map[string]any{"id": "original"})
		case "/v1/videos/original":
			polls++
			status := "in_progress"
			if polls > 1 {
				status = "completed"
			}
			json.NewEncoder(w).Encode(map[string]any{"id": "original", "status": status})
		case "/v1/videos/original/content":
			downloads++
			w.Header().Set("Content-Type", "video/mp4")
			w.Write([]byte("H3 video with soundtrack"))
		default:
			t.Errorf("unexpected %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	ctx := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL})
	policy := DefaultVideoPollPolicy()
	policy.Sleep = func(context.Context, time.Duration) error { return nil }
	result, err := RunVideoTaskWithPolicy(ctx, Input{Mode: "video", Prompt: "test", Config: Config{BaseURL: server.URL, APIKey: "test-key", InterfaceType: "newapi-channel-2", Model: "minimax-h3-max-turbo", VideoSeconds: "5", VQuality: "768"}}, policy)
	if err != nil {
		t.Fatal(err)
	}
	video, _ := result["video"].(map[string]interface{})
	_, data, err := DecodeProviderDataURL(stringField(video, "dataUrl"))
	if err != nil || string(data) != "H3 video with soundtrack" || creates != 1 || polls != 2 || downloads != 1 {
		t.Fatalf("result=%v counts=%d/%d/%d error=%v", result, creates, polls, downloads, err)
	}
}
