package protocol

import (
	"context"
	"testing"
)

// 豆包账号视频走本地网关：模型 id 只编码账号，豆包页面里的视频模型经
// providerOptions.doubao-gateway-video.video_model 传入；时长按数字发送，参考图内联。
func TestDoubaoGatewayVideoSendsPageVideoModelAndNumericDuration(t *testing.T) {
	adapter := officialPackageAdapter(t, "doubao-gateway-video.beeftv-plugin", "doubao-gateway-video")
	if adapter.Metadata().RequiresPublicMediaURLs {
		t.Fatal("本地网关接收内联参考图，不应强制要求公共媒体 URL")
	}
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "doubao-video-account-2", Prompt: "海边日落", Duration: 5, AspectRatio: "16:9",
		ProviderOptions: map[string]map[string]any{"doubao-gateway-video": {"video_model": "Seedance 2.0 Mini"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if create.Method != "POST" || create.Path != "/v1/video/generations" {
		t.Fatalf("create = %#v", create)
	}
	body := manifestTestBody(t, create)
	if body["model"] != "doubao-video-account-2" || body["prompt"] != "海边日落" {
		t.Fatalf("body = %#v", body)
	}
	if body["video_model"] != "Seedance 2.0 Mini" {
		t.Fatalf("video_model 必须传给网关，实际 body = %#v", body)
	}
	if d, ok := body["duration"].(float64); !ok || d != 5 {
		t.Fatalf("duration 应是数字 5，实际 %#v", body["duration"])
	}
	if body["aspect_ratio"] != "16:9" {
		t.Fatalf("aspect_ratio = %#v", body["aspect_ratio"])
	}

	// 没有选择页面模型时不发送 video_model，由网关沿用页面默认
	plain, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "doubao-video-account-1", Prompt: "x", Duration: 6, AspectRatio: "9:16",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, present := manifestTestBody(t, plain)["video_model"]; present {
		t.Fatal("未提供 video_model 时不应发送该字段")
	}
}
