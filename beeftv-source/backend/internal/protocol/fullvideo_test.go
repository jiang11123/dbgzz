package protocol

import (
	"context"
	"testing"
)

func TestFullVideoFullVideoWireContract(t *testing.T) {
	a := officialPackageAdapter(t, "full-video.beeftv-plugin", "full-video")
	request := GenerationRequest{Model: "sd-native-full-2.5", Prompt: "test", Duration: 5, Resolution: "480p", AspectRatio: "16:9", Extra: map[string]any{"idempotencyKey": "stable-fixture-key"}, Videos: []MediaReference{{URL: "https://media.example/video", Metadata: map[string]any{"durationMs": 3000}}}}
	spec, err := a.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	b := manifestTestBody(t, spec)
	if spec.ContentType != "application/json" || spec.Headers["Idempotency-Key"] != "stable-fixture-key" || b["seconds"] != float64(5) {
		t.Fatalf("unexpected create: %#v", spec)
	}
	refs := b["references"].([]any)
	r := refs[0].(map[string]any)
	if r["source"] != "https://media.example/video" || r["duration_seconds"] != float64(3) || r["role"] != "reference" {
		t.Fatalf("bad reference: %#v", r)
	}
	result, err := a.ParsePoll(context.Background(), PollContext{TaskID: "task_fixture"}, []byte(`{"id":"task_fixture","status":"completed","url":"/relative/untrusted"}`))
	if err != nil || result.Status != StatusSucceeded {
		t.Fatalf("poll: %#v %v", result, err)
	}
	if result.Result != nil && len(result.Result.Videos) > 0 {
		t.Fatal("must use authenticated result endpoint instead of response url")
	}
	request.Model = "H3-KS"
	if _, err = a.BuildCreate(context.Background(), RequestContext{Request: request}); err == nil {
		t.Fatal("unsupported model accepted")
	}
}
