package generation

import (
	"reflect"
	"testing"
)

func TestBeefAPIH3FullReferenceOrderControlsAndFrames(t *testing.T) {
	input := Input{Prompt: "Audio 1 describes Image 1.", Config: Config{Model: "minimax-h3-max", VideoSeconds: "5", VQuality: "768p"}, ReferenceImages: []Media{{ID: "first", URL: "https://example.com/first.png"}, {ID: "last", URL: "https://example.com/last.png"}, {ID: "middle", URL: "https://example.com/middle.png"}, {ID: "subject", URL: "https://example.com/subject.png"}}, ReferenceAudios: []Media{{ID: "audio", URL: "https://example.com/audio.wav"}}, Metadata: map[string]interface{}{"videoEditOperation": "reference_to_video", "videoStartFrameNodeId": "first", "videoEndFrameNodeId": "last", "videoMiddleFrameNodeId": "middle", "videoMiddleFrameTime": 2.5, "videoReferenceOrder": []string{"audio", "first", "subject"}, "videoH3Options": map[string]interface{}{"seed": float64(0), "enable_safety_checker": false, "sync_mode": true}}}
	body, err := beefAPIH3VideoBody(input)
	if err != nil {
		t.Fatal(err)
	}
	if body["seed"] != float64(0) || body["enable_safety_checker"] != true || body["sync_mode"] != false || body["middle_frame_time"] != 2.5 || body["reference_image_urls"] != nil {
		t.Fatalf("controls or frames lost: %#v", body)
	}
	want := []map[string]string{{"type": "audio", "url": "https://example.com/audio.wav"}, {"type": "image", "url": "https://example.com/subject.png"}}
	if !reflect.DeepEqual(body["reference_conditions"], want) {
		t.Fatalf("ordered conditions=%#v", body["reference_conditions"])
	}
	if !reflect.DeepEqual(input.Metadata["videoReferenceOrder"], []string{"audio", "first", "subject"}) {
		t.Fatal("building request mutated saved reference order")
	}
	input.Config.VQuality = "1080p"
	if _, err = beefAPIH3VideoBody(input); err == nil {
		t.Fatal("non-native middle frame accepted")
	}
}

func TestBeefAPIH3FullFractionalAndStylePayloads(t *testing.T) {
	input := Input{Prompt: "test", Config: Config{Model: "minimax-h3-max-turbo", VideoSeconds: "0.925", VQuality: "768p"}}
	body, err := beefAPIH3VideoBody(input)
	if err != nil || body["seconds"] != "0.925" {
		t.Fatalf("fractional request=%#v err=%v", body, err)
	}
	for model, style := range h3Styles {
		input := Input{Prompt: "test", Config: Config{Model: model, VideoSeconds: "5", VQuality: "768p"}, ReferenceImages: []Media{{ID: "frame", URL: "https://example.com/frame.png"}}, Metadata: map[string]interface{}{"videoStartFrameNodeId": "frame", "videoH3Options": map[string]interface{}{"seed": float64(0), "sync_mode": true, "enable_safety_checker": false, "prompt_expansion_mode": "quality", "damage_level": "heavy"}}}
		body, err := beefAPIH3VideoBody(input)
		if err != nil {
			t.Fatal(err)
		}
		if body["first_frame_url"] != "https://example.com/frame.png" || body["seed"] != float64(0) || body["sync_mode"] != nil || body["prompt_expansion_mode"] != nil || body["enable_safety_checker"] != nil {
			t.Fatalf("style controls leaked: %#v", body)
		}
		if style == "vhs" && body["damage_level"] != "heavy" {
			t.Fatal("VHS wear lost")
		}
		if style != "vhs" && body["damage_level"] != nil {
			t.Fatal("VHS option leaked to another style")
		}
	}
}
