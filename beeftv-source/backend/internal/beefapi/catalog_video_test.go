package beefapi

import (
	"encoding/json"
	"testing"
)

func TestNormalizeCatalogVideoCapabilityRejectsInvalidPayloads(t *testing.T) {
	valid := sampleCatalogVideo(t, 3, 1)
	if _, ok := NormalizeCatalogVideoCapability(valid); !ok {
		t.Fatal("valid capability rejected")
	}
	for _, raw := range []string{
		"",
		"null",
		`[]`,
		`{"operations":["text_to_video"]}`,
		`{"references":{},"duration":{"selection":"range","min":1,"max":15,"step":1,"default":6},"ratios":["16:9"],"defaultRatio":"16:9","resolutions":["720p"],"defaultResolution":"720p","generateAudio":{"supported":true},"watermark":{"supported":false,"default":false},"operations":["text_to_video"],"defaultOperation":"text_to_video"}`,
		`{"references":{"maxVideos":3.5},"duration":{"selection":"range","min":1,"max":15,"step":1,"default":6},"ratios":["16:9"],"defaultRatio":"16:9","resolutions":["720p"],"defaultResolution":"720p","generateAudio":{"supported":true,"default":true},"watermark":{"supported":false,"default":false},"operations":["text_to_video"],"defaultOperation":"text_to_video"}`,
	} {
		if _, ok := NormalizeCatalogVideoCapability(json.RawMessage(raw)); ok {
			t.Fatalf("accepted invalid payload %s", raw)
		}
	}
}

func TestNormalizeCatalogVideoCapabilityKeepsExplicitZerosAndOmitsMissing(t *testing.T) {
	video, ok := NormalizeCatalogVideoCapability(sampleCatalogVideo(t, 0, 0))
	if !ok {
		t.Fatal("explicit zeros rejected")
	}
	refs := video["references"].(map[string]any)
	if refs["maxVideos"] != 0 || refs["maxAudios"] != 0 {
		t.Fatalf("zeros rewritten: %#v", refs)
	}
	partial := json.RawMessage(`{
		"references": {"maxVideos": 0},
		"duration": {"selection": "enum", "values": [5, 10], "default": 5},
		"ratios": ["16:9"], "defaultRatio": "16:9", "resolutions": [], "defaultResolution": "",
		"generateAudio": {"supported": false, "default": false}, "watermark": {"supported": false, "default": false},
		"operations": ["text_to_video"], "defaultOperation": "text_to_video"
	}`)
	video, ok = NormalizeCatalogVideoCapability(partial)
	if !ok {
		t.Fatal("partial references rejected")
	}
	refs = video["references"].(map[string]any)
	if refs["maxVideos"] != 0 {
		t.Fatalf("maxVideos = %#v", refs["maxVideos"])
	}
	if _, present := refs["maxAudios"]; present {
		t.Fatalf("omitted maxAudios persisted as %#v", refs["maxAudios"])
	}
	if _, present := video["durationSupported"]; present {
		t.Fatal("optional durationSupported invented")
	}
}
