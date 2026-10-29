package protocol

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestVideoGenerationsJSONPreservesMediaAndOptions(t *testing.T) {
	a := officialPackageAdapter(t, "video-generations-json.beeftv-plugin", "video-generations-json")
	request := GenerationRequest{Capability: CapabilityVideo, Model: "seedance-2.5", Prompt: "move", Duration: 5, AspectRatio: "9:16", Resolution: "720p", GenerateAudio: false, Watermark: false,
		Images: []MediaReference{{URL: "https://example.com/two.png", Role: "last_frame", Order: 2}, {DataURL: "data:image/png;base64,aGVsbG8=", Role: "first_frame", Order: 1}},
		Videos: []MediaReference{{URL: "https://example.com/ref.mp4"}}, Audios: []MediaReference{{URL: "https://example.com/ref.wav"}},
	}
	spec, err := a.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, spec)
	images := body["images"].([]any)
	if spec.Path != "/v1/video/generations" || spec.ContentType != "application/json" || len(images) != 2 || len(spec.Files) != 0 {
		t.Fatalf("spec=%+v", spec)
	}
	first, last := images[0].(map[string]any), images[1].(map[string]any)
	if first["role"] != "first_frame" || first["url"] != request.Images[1].DataURL || last["role"] != "last_frame" || last["url"] != request.Images[0].URL {
		t.Fatalf("images=%+v", images)
	}
	encoded, _ := json.Marshal(body)
	for _, field := range []string{`"duration":5`, `"ratio":"9:16"`, `"generate_audio":false`, `"watermark":false`, `"videos":[`, `"audios":[`} {
		if !strings.Contains(string(encoded), field) {
			t.Fatalf("missing %s: %s", field, encoded)
		}
	}
	for _, field := range []string{"seconds", "aspect_ratio", "input_reference"} {
		if _, ok := body[field]; ok {
			t.Fatalf("unexpected field %s", field)
		}
	}
	request.Images = []MediaReference{{URL: "https://example.com/reference.png"}, {URL: "https://example.com/reference2.png", Role: "reference_image"}}
	spec, err = a.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range manifestTestBody(t, spec)["images"].([]any) {
		if raw.(map[string]any)["role"] != "reference_image" {
			t.Fatal("reference images must not become keyframes")
		}
	}
	created, err := a.ParseCreate(context.Background(), []byte(`{"id":"original","status":"pending"}`))
	if err != nil || created.TaskID != "original" {
		t.Fatalf("create=%+v err=%v", created, err)
	}
	poll, err := a.BuildPoll(context.Background(), PollContext{TaskID: created.TaskID})
	if err != nil || poll.Path != "/v1/video/generations/original" {
		t.Fatalf("poll=%+v err=%v", poll, err)
	}
	state, err := a.ParsePoll(context.Background(), PollContext{TaskID: created.TaskID}, []byte(`{"status":"completed","data":[{"url":"https://example.com/a.mp4"},{"url":"https://example.com/b.mp4"}]}`))
	if err != nil || state.Status != StatusSucceeded || state.Result == nil || len(state.Result.Videos) != 2 {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	state, err = a.ParsePoll(context.Background(), PollContext{TaskID: created.TaskID}, []byte(`{"status":"failed","error":{"code":"bad_reference","message":"image rejected"}}`))
	if err != nil || state.Status != StatusFailed || state.Message != "image rejected" {
		t.Fatalf("state=%+v err=%v", state, err)
	}
}

func TestOpenAIVideosRejectsMediaItCannotSend(t *testing.T) {
	a := officialPackageAdapter(t, "openai-videos.beeftv-plugin", "newapi")
	for name, request := range map[string]GenerationRequest{
		"two images": {Images: []MediaReference{{URL: "https://example.com/a.png"}, {URL: "https://example.com/b.png"}}},
		"video":      {Videos: []MediaReference{{URL: "https://example.com/a.mp4"}}},
		"audio":      {Audios: []MediaReference{{URL: "https://example.com/a.wav"}}},
		"last frame": {Images: []MediaReference{{URL: "https://example.com/a.png", Role: "last_frame"}}},
		"mask":       {Images: []MediaReference{{URL: "https://example.com/a.png", Role: "mask"}}},
	} {
		t.Run(name, func(t *testing.T) {
			request.Capability, request.Model, request.Prompt = CapabilityVideo, "seedance-2.5", "move"
			if _, err := a.BuildCreate(context.Background(), RequestContext{Request: request}); err == nil {
				t.Fatal("unsupported media was silently dropped")
			}
		})
	}
	for _, images := range [][]MediaReference{nil, {{URL: "https://example.com/a.png"}}} {
		spec, err := a.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Model: "sora-2", Prompt: "move", Images: images}})
		if err != nil || spec.ContentType != "multipart/form-data" || len(spec.Files) != len(images) {
			t.Fatalf("spec=%+v err=%v", spec, err)
		}
	}
}
