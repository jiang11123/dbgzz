package modelcatalog

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/beefapi"
)

func officialCatalogVideo(t *testing.T) json.RawMessage {
	t.Helper()
	return json.RawMessage(`{
		"references": {"promptMaxChars": 8000, "minImages": 0, "maxImages": 9, "maxVideos": 3, "maxAudios": 1, "maxImageBytes": 1, "maxVideoBytes": 1, "maxVideoDurationSeconds": 15, "maxAudioBytes": 1, "maxAudioDurationSeconds": 15},
		"duration": {"selection": "range", "min": 1, "max": 15, "step": 1, "default": 6},
		"ratios": ["16:9"], "defaultRatio": "16:9", "resolutions": ["720p"], "defaultResolution": "720p",
		"generateAudio": {"supported": true, "default": true}, "watermark": {"supported": false, "default": false},
		"operations": ["text_to_video", "image_to_video", "reference_to_video"], "defaultOperation": "text_to_video"
	}`)
}

func TestOverlayCatalogVideoCapabilitiesMatchesOfficialBeefAPIContract(t *testing.T) {
	raw := officialCatalogVideo(t)
	version := " 1 "
	items := OverlayCatalogVideoCapabilities([]ChannelModelCatalogItem{{
		ID: "seedance-2.0", VideoCapabilities: raw, VideoCapabilitiesVersion: &version,
	}})
	if len(items) != 1 || items[0].VideoCapabilitiesVersion == nil || *items[0].VideoCapabilitiesVersion != "1" {
		t.Fatalf("overlay version = %#v", items)
	}
	want, ok := beefapi.NormalizeCatalogVideoCapability(raw)
	if !ok {
		t.Fatal("official contract rejected the fixture")
	}
	wantRaw, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(items[0].VideoCapabilities, wantRaw) {
		t.Fatalf("overlay drifted from official contract: got %s want %s", items[0].VideoCapabilities, wantRaw)
	}
}

func TestOverlayCatalogVideoCapabilitiesClearsInvalidPayloads(t *testing.T) {
	version := "1"
	items := OverlayCatalogVideoCapabilities([]ChannelModelCatalogItem{
		{ID: "bad", VideoCapabilities: json.RawMessage(`{"operations":["text_to_video"]}`), VideoCapabilitiesVersion: &version},
		{ID: "empty", VideoCapabilities: json.RawMessage(`null`)},
	})
	for _, item := range items {
		if item.VideoCapabilities != nil || item.VideoCapabilitiesVersion != nil {
			t.Fatalf("invalid overlay retained: %#v", item)
		}
	}
}

func TestMergeCatalogExtrasEnrichesAndAppends(t *testing.T) {
	catalog := []ChannelModelCatalogItem{{ID: "qwen-plus"}, {ID: "happyhorse-1.1-t2v"}}
	merged := MergeCatalogExtras(catalog, []ChannelModelCatalogItem{
		{ID: "happyhorse-1.1-t2v", DisplayName: "HappyHorse 1.1 文生视频", ModelType: "video", SupportedEndpointTypes: []string{"video"}},
		{ID: "wan2.7-t2v-2026-06-12", DisplayName: "万相 2.7 文生视频", ModelType: "video"},
		{ID: "  "},
	})
	if len(merged) != 3 || merged[0].ID != "happyhorse-1.1-t2v" || merged[1].ID != "qwen-plus" || merged[2].ID != "wan2.7-t2v-2026-06-12" {
		t.Fatalf("merged ids = %#v", merged)
	}
	if merged[0].DisplayName != "HappyHorse 1.1 文生视频" || merged[0].ModelType != "video" {
		t.Fatalf("existing extra was not enriched: %#v", merged[0])
	}
}

func TestLoadChannelModelCatalogCustomGeminiAndBeefAPI(t *testing.T) {
	raw := officialCatalogVideo(t)
	beefAPIBody, err := json.Marshal(map[string]any{
		"data": []map[string]any{{
			"id": "doubao-seedance-2-0", "display_name": "Seedance 2.0", "model_type": "video",
			"video_capabilities": json.RawMessage(raw), "video_capabilities_version": "gateway-1",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	geminiCalled := false
	gemini, err := LoadChannelModelCatalog(context.Background(), func(ctx context.Context, baseURL, apiFormat, apiKey string, headers []ChannelHeader) ([]byte, error) {
		geminiCalled = true
		if apiFormat != "gemini" || !strings.Contains(baseURL, "generativelanguage") {
			t.Fatalf("gemini fetch = %q %q", baseURL, apiFormat)
		}
		return []byte(`{"models":[{"name":"models/gemini-pro","display_name":"Gemini Pro","model_type":"text"}]}`), nil
	}, "https://generativelanguage.googleapis.com/v1beta", "gemini", "k", nil, nil)
	if err != nil || !geminiCalled || len(gemini) != 1 || gemini[0].ID != "gemini-pro" || gemini[0].ModelType != "text" {
		t.Fatalf("gemini catalog = %#v %v called=%v", gemini, err, geminiCalled)
	}

	extrasCalled := false
	custom, err := LoadChannelModelCatalog(context.Background(), func(ctx context.Context, baseURL, apiFormat, apiKey string, headers []ChannelHeader) ([]byte, error) {
		if apiFormat != "openai" || apiKey != "k" {
			t.Fatalf("custom fetch = %q %q", apiFormat, apiKey)
		}
		return []byte(`{"data":[{"id":"qwen-plus"}]}`), nil
	}, "https://dashscope.aliyuncs.com/compatible-mode/v1", "openai", "k", nil, func(baseURL, apiFormat string, headers []ChannelHeader) []ChannelModelCatalogItem {
		extrasCalled = true
		if !strings.Contains(baseURL, "dashscope.aliyuncs.com") || apiFormat != "openai" {
			t.Fatalf("extras args = %q %q", baseURL, apiFormat)
		}
		return []ChannelModelCatalogItem{{ID: "happyhorse-1.1-t2v", DisplayName: "HappyHorse 1.1 文生视频", ModelType: "video"}}
	})
	if err != nil || !extrasCalled || len(custom) != 2 || custom[0].ID != "happyhorse-1.1-t2v" || custom[1].ID != "qwen-plus" {
		t.Fatalf("custom catalog = %#v %v extras=%v", custom, err, extrasCalled)
	}

	beef, err := LoadChannelModelCatalog(context.Background(), func(context.Context, string, string, string, []ChannelHeader) ([]byte, error) {
		return beefAPIBody, nil
	}, "https://enterprise.beefapi.com/v1", "openai", "k", nil, nil)
	if err != nil || len(beef) != 1 || beef[0].ID != "doubao-seedance-2-0" || beef[0].VideoCapabilitiesVersion == nil || *beef[0].VideoCapabilitiesVersion != "gateway-1" {
		t.Fatalf("beefapi catalog = %#v %v", beef, err)
	}
	want, ok := beefapi.NormalizeCatalogVideoCapability(raw)
	if !ok {
		t.Fatal("official contract rejected BeefAPI fixture")
	}
	wantRaw, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(beef[0].VideoCapabilities, wantRaw) {
		t.Fatalf("BeefAPI/WhatsToken overlay drifted: got %s", beef[0].VideoCapabilities)
	}
}

func TestLoadChannelModelCatalogRejectsMissingCredentialsWithoutFetch(t *testing.T) {
	called := false
	fetcher := func(context.Context, string, string, string, []ChannelHeader) ([]byte, error) {
		called = true
		return []byte(`{"data":[]}`), nil
	}
	if _, err := LoadChannelModelCatalog(context.Background(), fetcher, "https://example.com/v1", "openai", "", nil, nil); err == nil || called {
		t.Fatalf("empty key reached fetcher: called=%v err=%v", called, err)
	}
	if _, err := LoadChannelModelCatalog(context.Background(), fetcher, "", "openai", "k", nil, func(string, string, []ChannelHeader) []ChannelModelCatalogItem {
		t.Fatal("extras ran before validation")
		return nil
	}); err == nil || called {
		t.Fatalf("empty url reached fetcher: called=%v err=%v", called, err)
	}
}
