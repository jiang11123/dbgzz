package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSeedance25EnterpriseFirstFrameIsExplicit(t *testing.T) {
	for _, name := range []string{"seedance-2.5", "seedance-2.5-official"} {
		input := canvasGenerationInput{Mode: "video", Config: providerConfig{Model: name, Size: "9:16", VideoSeconds: "6", VQuality: "720p"}, ReferenceImages: []providerMedia{{ID: "first", DataURL: testReferenceImageDataURL}}}
		body, err := beefAPIVideoRequestBody(input)
		if err != nil {
			t.Fatal(err)
		}
		content := body["content"].([]map[string]interface{})
		if content[0]["role"] != "first_frame" || body["metadata"].(map[string]interface{})["ratio"] != "adaptive" || body["seconds"] != "6" {
			t.Fatalf("incorrect frame options: %#v", body)
		}
		request := protocolRequestFromInput(input)
		if request.Images[0].Role != "first_frame" || request.AspectRatio != "adaptive" {
			t.Fatalf("native request differs: %#v", request)
		}
		input.Metadata = map[string]interface{}{"videoEditOperation": "reference_to_video"}
		body, err = beefAPIVideoRequestBody(input)
		if err != nil {
			t.Fatal(err)
		}
		if body["metadata"].(map[string]interface{})["omni_reference_task_type"] != "reference" || body["content"].([]map[string]interface{})[0]["role"] != "reference_image" || body["metadata"].(map[string]interface{})["ratio"] != "9:16" {
			t.Fatalf("reference intent changed: %#v", body)
		}
	}
}

func TestSeedance20EnterpriseReferencesUnchanged(t *testing.T) {
	input := canvasGenerationInput{Config: providerConfig{Model: "seedance-2.0", Size: "9:16", VideoSeconds: "6"}, ReferenceImages: []providerMedia{{ID: "a", URL: "https://example.com/a.png"}, {ID: "b", URL: "https://example.com/b.png"}}}
	body, err := beefAPIVideoRequestBody(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range body["content"].([]map[string]interface{}) {
		if item["role"] != "reference_image" {
			t.Fatal("2.0 reference intent changed")
		}
	}
}

func TestSeedanceLegacyVideoBodyPreservesExplicitIntent(t *testing.T) {
	for _, tc := range []struct{ model, op, want string }{{"seedance-2.5", "reference_to_video", "reference"}, {"seedance-2.5", "extend", "extend"}, {"seedance-2.5", "inpaint", "edit"}, {"seedance-2.0", "reference_to_video", ""}} {
		input := canvasGenerationInput{Config: providerConfig{Model: tc.model, Size: "16:9", VideoSeconds: "5"}, Metadata: map[string]interface{}{"videoEditOperation": tc.op}, ReferenceVideos: []providerMedia{{URL: "https://example.com/a.mp4"}}}
		body, err := seedanceVideosRequestBody(input)
		if err != nil {
			t.Fatal(err)
		}
		wire, e := requestAsMap(body)
		if e != nil {
			t.Fatal(e)
		}
		if tc.want != "" && wire["omni_reference_task_type"] != tc.want {
			t.Fatalf("bad wire: %v", wire)
		}
		if body.OmniReferenceTaskType != tc.want {
			t.Fatalf("%s %s: %s", tc.model, tc.op, body.OmniReferenceTaskType)
		}
	}
}

func TestSeedanceLegacyArkSendsReferenceIntent(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["omni_reference_task_type"] != "reference" || body["ratio"] != "16:9" || body["duration"] != float64(5) {
			t.Errorf("wrong wire: %v", body)
		}
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":{"message":"test completed"}}`))
	}))
	defer server.Close()
	input := canvasGenerationInput{Config: providerConfig{Model: "seedance-2.5", BaseURL: server.URL, APIKey: "test", Size: "16:9", VideoSeconds: "5"}, Metadata: map[string]interface{}{"videoEditOperation": "reference_to_video"}, ReferenceImages: []providerMedia{{URL: "https://example.com/a.png"}}}
	_, _ = runSeedanceAgentPlanVideoTask(context.Background(), input, videoPollPolicy{})
	if !called {
		t.Fatal("request not sent")
	}
}
