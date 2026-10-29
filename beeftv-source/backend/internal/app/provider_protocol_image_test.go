package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func TestProtocolRequestMapsOpenAICanvasRatioToPixelSize(t *testing.T) {
	profile := DefaultImageCapabilityConfig("openai-image", "gpt-image-2")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "gpt-image-2", InterfaceType: "openai-image", Size: "16:9", Quality: "2k"},
		ImageCapability: profile,
	})
	if request.AspectRatio != "1824x1024" {
		t.Fatalf("AspectRatio = %q, want 1824x1024", request.AspectRatio)
	}
	if request.Output.AspectRatio != "1824x1024" {
		t.Fatalf("Output.AspectRatio = %q, want 1824x1024", request.Output.AspectRatio)
	}
	if request.Quality != "2k" {
		t.Fatalf("Quality = %q, want 2k for plugin-side mapping", request.Quality)
	}
}

func TestProtocolRequestKeepsSeedreamCanvasRatioWhenCapabilityUsesSize(t *testing.T) {
	profile := DefaultImageCapabilityConfig("volcengine-ark-image", "doubao-seedream-5-0-260128")
	if profile.Size.Parameter != "size" {
		t.Fatalf("ark image parameter = %q, want size", profile.Size.Parameter)
	}
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "doubao-seedream-5-0-260128", InterfaceType: "volcengine-ark-image", Size: "16:9"},
		ImageCapability: profile,
	})
	if request.AspectRatio != "16:9" {
		t.Fatalf("AspectRatio = %q, want canvas 16:9 so Seedream can map 2560x1440", request.AspectRatio)
	}
}

func TestProtocolSeedreamPluginMapsCanvasRatioNotHostPixels(t *testing.T) {
	adapter := officialSourceProviderAdapter(t, "volcengine-ark-seedream", "volcengine-ark-image")
	profile := DefaultImageCapabilityConfig("volcengine-ark-image", "doubao-seedream-5-0-260128")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "doubao-seedream-5-0-260128", InterfaceType: "volcengine-ark-image", Size: "16:9"},
		ImageCapability: profile,
	})
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := marshalProtocolBody(t, spec.Body)
	if body["size"] != "2560x1440" {
		t.Fatalf("seedream size = %#v, want 2560x1440", body["size"])
	}
}

func TestProtocolQwenImagePluginMapsCanvasRatio(t *testing.T) {
	adapter := officialSourceProviderAdapter(t, "dashscope-qwen-image", "dashscope-qwen-image")
	profile := DefaultImageCapabilityConfig("dashscope-qwen-image", "qwen-image-3.0-pro")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "qwen-image-3.0-pro", InterfaceType: "dashscope-qwen-image", Size: "16:9"},
		ImageCapability: profile,
	})
	if request.AspectRatio != "16:9" {
		t.Fatalf("AspectRatio = %q, want 16:9", request.AspectRatio)
	}
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := marshalProtocolBody(t, spec.Body)
	parameters, _ := body["parameters"].(map[string]any)
	if parameters["size"] != "1536*864" {
		t.Fatalf("qwen size = %#v, want 1536*864", parameters["size"])
	}
}

func TestProtocolGeminiImageKeepsAspectRatio(t *testing.T) {
	adapter := officialSourceProviderAdapter(t, "google-gemini-image", "gemini-image")
	profile := DefaultImageCapabilityConfig("gemini-image", "gemini-3-pro-image-preview")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "gemini-3-pro-image-preview", InterfaceType: "gemini-image", Size: "16:9", Quality: "2k"},
		ImageCapability: profile,
	})
	if request.AspectRatio != "16:9" {
		t.Fatalf("AspectRatio = %q, want 16:9", request.AspectRatio)
	}
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := marshalProtocolBody(t, spec.Body)
	generationConfig, _ := body["generationConfig"].(map[string]any)
	imageConfig, _ := generationConfig["imageConfig"].(map[string]any)
	if imageConfig["aspectRatio"] != "16:9" {
		t.Fatalf("gemini aspectRatio = %#v, want 16:9", imageConfig["aspectRatio"])
	}
}

func TestProtocolRequestKeepsGrokImageAspectRatio(t *testing.T) {
	profile := DefaultImageCapabilityConfig("grok-image", "grok-imagine-image")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "grok-imagine-image", InterfaceType: "grok-image", Size: "16:9", Quality: "2k"},
		ImageCapability: profile,
	})
	if request.AspectRatio != "16:9" {
		t.Fatalf("AspectRatio = %q, want 16:9", request.AspectRatio)
	}
}

func TestProtocolRequestLeavesVideoAspectRatioUnconverted(t *testing.T) {
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:   "video",
		Prompt: "a clip",
		Config: providerConfig{Model: "grok-imagine-video-1.5", InterfaceType: "xai-video", Size: "16:9", VideoSeconds: "6"},
	})
	if request.AspectRatio != "16:9" {
		t.Fatalf("video AspectRatio = %q, want 16:9", request.AspectRatio)
	}
}

func TestProtocolOpenAIImagesPluginPayloadUsesPixelSize(t *testing.T) {
	adapter := officialSourceProviderAdapter(t, "openai-images", "openai-image")
	profile := DefaultImageCapabilityConfig("openai-image", "gpt-image-2")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "gpt-image-2", InterfaceType: "openai-image", Size: "16:9", Quality: "2k"},
		ImageCapability: profile,
	})
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := marshalProtocolBody(t, spec.Body)
	if body["size"] != "1824x1024" {
		t.Fatalf("openai-images size = %#v, want 1824x1024", body["size"])
	}
	if body["quality"] != "medium" {
		t.Fatalf("openai-images quality = %#v, want medium", body["quality"])
	}
	if spec.Path != "/v1/images/generations" {
		t.Fatalf("path = %q", spec.Path)
	}
}

func TestProtocolGrokImagesPluginPayloadKeepsAspectRatio(t *testing.T) {
	adapter := officialSourceProviderAdapter(t, "xai-grok-images", "grok-image")
	profile := DefaultImageCapabilityConfig("grok-image", "grok-imagine-image")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "grok-imagine-image", InterfaceType: "grok-image", Size: "16:9", Quality: "2k"},
		ImageCapability: profile,
	})
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := marshalProtocolBody(t, spec.Body)
	if body["aspect_ratio"] != "16:9" {
		t.Fatalf("grok-image aspect_ratio = %#v, want 16:9", body["aspect_ratio"])
	}
	if _, exists := body["size"]; exists {
		t.Fatalf("grok-image must omit size: %#v", body)
	}
	if body["resolution"] != "2k" {
		t.Fatalf("grok-image resolution = %#v, want 2k", body["resolution"])
	}
}

func officialSourceProviderAdapter(t *testing.T, pluginID, providerID string) protocol.Adapter {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", pluginID, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	adapters, err := protocol.LoadInstalledProviders(data, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, adapter := range adapters {
		if adapter.Metadata().ID == providerID {
			return adapter
		}
	}
	t.Fatalf("provider %s is missing from %s", providerID, pluginID)
	return nil
}

func marshalProtocolBody(t *testing.T, value any) map[string]any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatal(err)
	}
	return body
}
