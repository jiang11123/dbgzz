package generation

import (
	"reflect"
	"testing"
)

func TestBeefAPIH3FamilyBodyKeepsModelAndRoles(t *testing.T) {
	for _, name := range []string{"minimax-h3", "minimax-h3-max", "minimax-h3-max-turbo"} {
		input := Input{Prompt: "test", Config: Config{Model: name, VideoSeconds: "5", VQuality: "768"}, ReferenceImages: []Media{{ID: "last", DataURL: "data:image/png;base64,dGVzdA=="}}, Metadata: map[string]interface{}{"videoEndFrameNodeId": "last"}}
		body, err := BeefAPIVideoRequestBody(input)
		if err != nil {
			t.Fatal(err)
		}
		if body["model"] != name || body["resolution"] != "768p" || body["last_frame_url"] != "data:image/png;base64,dGVzdA==" || body["first_frame_url"] != nil || body["aspect_ratio"] != nil {
			t.Fatalf("model or end-only role lost: %#v", body)
		}
	}
	if IsBeefAPIH3Model("minimax-h3-max-turbo-other") {
		t.Fatal("unknown H3 suffix accepted")
	}
}

func TestBeefAPIH3BaseReferencesStayMultimodal(t *testing.T) {
	input := Input{Prompt: "Image 1 walks like Video 1. Audio 1 supplies the voice.", Config: Config{Model: "minimax-h3", VideoSeconds: "5", VQuality: "2k", Size: "16:9"}, ReferenceImages: []Media{{ID: "ref", DataURL: "data:image/png;base64,dGVzdA=="}}, ReferenceVideos: []Media{{DataURL: "data:video/mp4;base64,dGVzdA=="}}, ReferenceAudios: []Media{{DataURL: "data:audio/wav;base64,dGVzdA=="}}}
	body, err := BeefAPIVideoRequestBody(input)
	if err != nil {
		t.Fatal(err)
	}
	if body["operation"] != "reference_to_video" || body["resolution"] != "2k" || body["target_audio_url"] != nil {
		t.Fatalf("wrong reference mode: %#v", body)
	}
	for key, want := range map[string][]string{"reference_image_urls": {"data:image/png;base64,dGVzdA=="}, "reference_video_urls": {"data:video/mp4;base64,dGVzdA=="}, "reference_audio_urls": {"data:audio/wav;base64,dGVzdA=="}} {
		if !reflect.DeepEqual(body[key], want) {
			t.Fatalf("%s=%v", key, body[key])
		}
	}
	input.Metadata = map[string]interface{}{"videoStartFrameNodeId": "ref"}
	if _, err = BeefAPIVideoRequestBody(input); err == nil {
		t.Fatal("mixed keyframes and reference mode accepted")
	}
	input.Metadata = nil
	input.Config.Model = "minimax-h3-max"
	input.Config.VQuality = "768p"
	if _, err = BeefAPIVideoRequestBody(input); err != nil {
		t.Fatalf("Max references rejected: %v", err)
	}
}

func TestBeefAPIH3VariantDurationAndResolution(t *testing.T) {
	for _, tc := range []struct {
		model, seconds, resolution string
		ok                         bool
	}{
		{"minimax-h3", "5", "2k", true}, {"minimax-h3", "5", "1440", true}, {"minimax-h3", "15", "4k", true},
		{"minimax-h3", "3", "768", false}, {"minimax-h3", "5", "1080p", false},
		{"minimax-h3-max", "3", "768p", true}, {"minimax-h3-max", "5", "2k", false},
	} {
		_, err := BeefAPIVideoRequestBody(Input{Prompt: "test", Config: Config{Model: tc.model, VideoSeconds: tc.seconds, VQuality: tc.resolution}})
		if (err == nil) != tc.ok {
			t.Fatalf("%+v: %v", tc, err)
		}
	}
}
