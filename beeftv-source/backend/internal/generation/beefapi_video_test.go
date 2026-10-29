package generation

import "testing"

func TestBeefAPIVideoSingleReferencePreservesSelectedRatio(t *testing.T) {
	for _, name := range []string{"seedance-2.0", "seedance-2.0-fast", "seedance-2.0-mini", "seedance-2.0-portrait"} {
		t.Run(name, func(t *testing.T) {
			body, err := BeefAPIVideoRequestBody(Input{
				Prompt:          "keep the scene",
				Config:          Config{Model: name, Size: "16:9", VQuality: "480", VideoSeconds: "5", VideoGenerateAudio: "false"},
				ReferenceImages: []Media{{ID: "reference", URL: "https://example.com/landscape-4-3.png"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			content, ok := body["content"].([]map[string]interface{})
			if !ok || len(content) != 1 || content[0]["type"] != "image_url" || content[0]["role"] != "reference_image" {
				t.Fatalf("ordinary reference became a first frame: %#v", body)
			}
			if image, ok := content[0]["image_url"].(map[string]interface{}); !ok || image["url"] != "https://example.com/landscape-4-3.png" {
				t.Fatalf("reference URL changed: %#v", content[0])
			}
			metadata, ok := body["metadata"].(map[string]interface{})
			if !ok || metadata["ratio"] != "16:9" || metadata["generate_audio"] != false {
				t.Fatalf("selected ratio or explicit audio=false lost: %#v", body)
			}
			if body["model"] != name || body["seconds"] != "5" || body["resolution"] != "480p" {
				t.Fatalf("generation controls changed: %#v", body)
			}
			for _, field := range []string{"image", "aspect_ratio", "duration"} {
				if _, present := body[field]; present {
					t.Fatalf("reference request contains legacy field %s: %#v", field, body)
				}
			}
		})
	}
}

func TestBeefAPIVideoFrameContractsRemainExplicit(t *testing.T) {
	for _, tc := range []struct {
		name, model string
		metadata    map[string]interface{}
		imageCount  int
		roles       []string
		ratio       string
	}{
		{name: "2.0 explicit first frame", model: "seedance-2.0-fast", metadata: map[string]interface{}{"videoStartFrameNodeId": "first"}, imageCount: 1},
		{name: "2.5 default first frame", model: "seedance-2.5", imageCount: 1, roles: []string{"first_frame"}, ratio: "adaptive"},
		{name: "2.5 portrait default first frame", model: "seedance-2.5-portrait", imageCount: 1, roles: []string{"first_frame"}, ratio: "adaptive"},
		{name: "2.5 explicit last frame", model: "seedance-2.5", metadata: map[string]interface{}{"videoEndFrameNodeId": "first"}, imageCount: 1, roles: []string{"last_frame"}, ratio: "adaptive"},
		{name: "2.5 default first and last frames", model: "seedance-2.5", imageCount: 2, roles: []string{"first_frame", "last_frame"}, ratio: "adaptive"},
		{name: "2.5 explicit reference", model: "seedance-2.5", metadata: map[string]interface{}{"videoEditOperation": "reference_to_video"}, imageCount: 1, roles: []string{"reference_image"}, ratio: "16:9"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			images := []Media{{ID: "first", URL: "https://example.com/first.png"}, {ID: "last", URL: "https://example.com/last.png"}}
			body, err := BeefAPIVideoRequestBody(Input{
				Config:          Config{Model: tc.model, Size: "16:9", VQuality: "480", VideoSeconds: "5"},
				ReferenceImages: images[:tc.imageCount], Metadata: tc.metadata,
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(tc.roles) == 0 {
				image, ok := body["image"].(map[string]interface{})
				if !ok || image["url"] != images[0].URL {
					t.Fatalf("legacy explicit first frame changed: %#v", body)
				}
				for _, field := range []string{"aspect_ratio", "metadata", "content"} {
					if _, present := body[field]; present {
						t.Fatalf("legacy first frame contains unsupported %s: %#v", field, body)
					}
				}
				return
			}
			content, ok := body["content"].([]map[string]interface{})
			if !ok || len(content) != len(tc.roles) {
				t.Fatalf("frame content changed: %#v", body)
			}
			for i, role := range tc.roles {
				if content[i]["role"] != role {
					t.Fatalf("frame role[%d] = %#v, want %s", i, content[i]["role"], role)
				}
			}
			if body["metadata"].(map[string]interface{})["ratio"] != tc.ratio {
				t.Fatalf("frame ratio changed: %#v", body)
			}
		})
	}
}
