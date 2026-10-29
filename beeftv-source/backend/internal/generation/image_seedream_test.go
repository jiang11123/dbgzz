package generation

import (
	"context"
	"testing"
)

func TestSeedreamManagedReferencesUseOneJSONGeneration(t *testing.T) {
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "replace object <bbox>10 10 100 100</bbox>", Config: Config{Model: "dola-seedream-5-0-pro-260628", BaseURL: "https://beeftv.app", APIKey: "synthetic", InterfaceType: "openai-image", Size: "1.5K", SeedreamOutputFormat: "png", SeedreamOptimize: "fast"}, ReferenceImages: []Media{{DataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII="}}}
	result, err := RunImageTask(WithRuntime(context.Background(), Runtime{Images: port}), input)
	if err != nil {
		t.Fatal(err)
	}
	if port.calls != 1 || port.path != "/v1/images/generations" || port.contentType != "application/json" || result["mode"] != "image" {
		t.Fatalf("wire=%#v result=%#v", port, result)
	}
	if port.body["image"] == nil || port.body["size"] != "1.5K" || port.body["output_format"] != "png" || port.body["watermark"] != false {
		t.Fatalf("body=%#v", port.body)
	}
	if _, exists := port.body["n"]; exists {
		t.Fatal("n must not be sent to Ark")
	}
}

func TestSeedreamGroupAndLayerOptionsStayInOneRequest(t *testing.T) {
	input := Input{Prompt: "three matching views", Config: Config{Model: "seedream-4-5-251128", Size: "4K", SeedreamMaxImages: "3"}}
	body, err := seedreamImageBody(input)
	if err != nil {
		t.Fatal(err)
	}
	if body["sequential_image_generation"] != "auto" || body["sequential_image_generation_options"].(map[string]any)["max_images"] != 3 {
		t.Fatalf("body=%#v", body)
	}
	input.Config.Model = "dola-seedream-5-0-flash-260915"
	input.Config.Size = "2K"
	input.Config.SeedreamMode = "layers"
	if _, err = seedreamImageBody(input); err == nil {
		t.Fatal("layers require a source image")
	}
	input.ReferenceImages = []Media{{URL: "https://example.test/source.png"}}
	body, err = seedreamImageBody(input)
	if err != nil {
		t.Fatal(err)
	}
	if body["layer_decomposition"] != true {
		t.Fatalf("body=%#v", body)
	}
	if _, exists := body["sequential_image_generation"]; exists {
		t.Fatal("Flash must not receive group generation")
	}
}

func TestSeedreamCustomGatewayKeepsConfiguredVersion(t *testing.T) {
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "a cup", Config: Config{Model: "seedream-4-0-250828", BaseURL: "http://127.0.0.1:33022/v1", APIKey: "synthetic", InterfaceType: "openai-image", Size: "1600x600"}}
	_, err := RunImageTask(WithRuntime(context.Background(), Runtime{Images: port}), input)
	if err != nil {
		t.Fatal(err)
	}
	if port.path != "/v1/images/generations" || port.body["size"] != "1600x600" {
		t.Fatalf("wire=%#v", port)
	}
}

func TestSeedreamStreamKeepsDeliveredImagesAfterPartialFailure(t *testing.T) {
	data := []byte("data: {\"type\":\"image_generation.partial_succeeded\",\"image_index\":0,\"url\":\"https://example.test/0.png\",\"size\":\"2048x2048\"}\n\ndata: {\"type\":\"image_generation.partial_failed\",\"image_index\":1,\"error\":{\"message\":\"filtered\"}}\n\n")
	payload, err := readSeedreamImageEvents(data)
	if err != nil || len(payload.Data) != 1 {
		t.Fatalf("payload=%#v err=%v", payload, err)
	}
	if _, err = readSeedreamImageEvents([]byte("data: {\"type\":\"error\",\"error\":{\"message\":\"failed\"}}\n")); err == nil {
		t.Fatal("empty stream must fail")
	}
}
