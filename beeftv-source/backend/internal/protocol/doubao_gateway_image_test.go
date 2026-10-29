package protocol

import (
	"context"
	"testing"
)

// 豆包账号图片走本地网关：账号编码在模型 id 里，页面图片模型经
// providerOptions.doubao-gateway-image.image_model 传入，比例直接作为 size，结果要 b64_json。
func TestDoubaoGatewayImageSendsPageImageModelAndRatio(t *testing.T) {
	adapter := officialPackageAdapter(t, "doubao-gateway-image.beeftv-plugin", "doubao-gateway-image")
	if adapter.Metadata().RequiresPublicMediaURLs {
		t.Fatal("本地网关接收内联参考图，不应强制要求公共媒体 URL")
	}
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "doubao-image-account-2", Prompt: "一只奶蛙", AspectRatio: "16:9", ImageCount: 1,
		ProviderOptions: map[string]map[string]any{"doubao-gateway-image": {"image_model": "Seedream 4.0"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if create.Method != "POST" || create.Path != "/v1/images/generations" {
		t.Fatalf("create = %#v", create)
	}
	body := manifestTestBody(t, create)
	if body["model"] != "doubao-image-account-2" || body["prompt"] != "一只奶蛙" {
		t.Fatalf("body = %#v", body)
	}
	if body["image_model"] != "Seedream 4.0" {
		t.Fatalf("image_model 必须传给网关，实际 body = %#v", body)
	}
	if body["size"] != "16:9" {
		t.Fatalf("size 应直接是比例 16:9，实际 %#v", body["size"])
	}
	if body["response_format"] != "b64_json" {
		t.Fatalf("应要求 b64_json，实际 %#v", body["response_format"])
	}

	plain, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "doubao-image-account-1", Prompt: "x", AspectRatio: "1:1",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, present := manifestTestBody(t, plain)["image_model"]; present {
		t.Fatal("未提供 image_model 时不应发送该字段")
	}
}
