package generation

import (
	"context"
	"testing"

	"infinite-canvas/backend/internal/providerpreset"
)

func TestDomesticGatewayVideoContractDoesNotGrantHostedCredentials(t *testing.T) {
	for _, base := range []string{"https://beefapi.com/v1", "https://BEEFAPI.COM:443/v1"} {
		if !IsBeefAPIVideoConfig(context.Background(), Config{BaseURL: base}) {
			t.Fatalf("domestic video gateway rejected: %s", base)
		}
		if providerpreset.IsBeefAPIEndpoint(base) {
			t.Fatal("domestic custom channel must not become a hosted-account endpoint")
		}
	}
	for _, base := range []string{"http://beefapi.com/v1", "https://beefapi.com.attacker.test/v1", "https://attacker.test/beefapi.com", "https://user@beefapi.com/v1", "https://beefapi.com:444/v1"} {
		if IsBeefAPIVideoConfig(context.Background(), Config{BaseURL: base}) {
			t.Fatalf("unexpected video gateway: %s", base)
		}
	}
	input := Input{Prompt: "change the ball", Config: Config{BaseURL: "https://beefapi.com/v1", InterfaceType: "newapi", Model: "seedance-2.5", VideoSeconds: "4", VQuality: "480", Size: "16:9", VideoGenerateAudio: "false", VideoWatermark: "false"}, Metadata: map[string]any{"videoEditOperation": "inpaint"}, ReferenceVideos: []Media{{URL: "https://example.com/ref.mp4"}}}
	body, err := BeefAPIVideoRequestBody(input)
	if err != nil {
		t.Fatal(err)
	}
	meta := body["metadata"].(map[string]interface{})
	content := body["content"].([]map[string]interface{})
	if len(content) != 1 || content[0]["type"] != "video_url" || content[0]["role"] != "reference_video" || body["seconds"] != "-1" || meta["ratio"] != "adaptive" || meta["omni_reference_task_type"] != "edit" || meta["generate_audio"] != false || meta["watermark"] != false {
		t.Fatalf("edit controls were lost: %#v", body)
	}
}

func TestBeefAPITextVideoPreservesWatermarkSwitch(t *testing.T) {
	for _, enabled := range []string{"true", "false"} {
		body, err := BeefAPIVideoRequestBody(Input{Config: Config{Model: "seedance-2.5", VideoSeconds: "4", VQuality: "480", Size: "16:9", VideoWatermark: enabled}})
		if err != nil {
			t.Fatal(err)
		}
		if body["watermark"] != (enabled == "true") {
			t.Fatalf("watermark=%s was lost: %#v", enabled, body)
		}
	}
}
