package generation

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBeefAPIH3LiveCanary(t *testing.T) {
	infoPath := os.Getenv("FAL_H3_LIVE_GATEWAY_INFO")
	if infoPath == "" {
		t.Skip("explicit paid canary opt-in required")
	}
	data, err := os.ReadFile(infoPath)
	if err != nil {
		t.Fatal(err)
	}
	var info struct {
		BaseURL string `json:"base_url"`
		Token   string `json:"token"`
	}
	if err := json.Unmarshal(data, &info); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "1")
	ctx := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: info.BaseURL})
	first, last := h3SyntheticFrame(t, false), h3SyntheticFrame(t, true)
	audio := h3SyntheticAudio()
	cases := []struct {
		name, resolution string
		images, audios   []Media
		metadata         map[string]interface{}
	}{
		{"text-768p", "768", nil, nil, nil},
		{"first-last-480p", "480", []Media{{ID: "first", DataURL: first}, {ID: "last", DataURL: last}}, nil, map[string]interface{}{"videoStartFrameNodeId": "first", "videoEndFrameNodeId": "last"}},
		{"last-only-1080p", "1080", []Media{{ID: "last", DataURL: last}}, nil, map[string]interface{}{"videoEndFrameNodeId": "last"}},
		{"pinned-audio-768p", "768", nil, []Media{{ID: "audio", DataURL: audio}}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input := Input{Mode: "video", Prompt: "A small red paper ball rolls gently across a pale teal tabletop. One continuous shot, slow natural motion, soft daylight, fixed camera, no text.", Config: Config{BaseURL: info.BaseURL, APIKey: info.Token, InterfaceType: "newapi-channel-2", Model: "minimax-h3-max-turbo", VideoSeconds: "3", VQuality: tc.resolution, Size: "16:9"}, ReferenceImages: tc.images, ReferenceAudios: tc.audios, Metadata: tc.metadata}
			bounded, cancel := context.WithTimeout(ctx, 110*time.Second)
			defer cancel()
			result, err := RunVideoTaskWithPolicy(bounded, input, DefaultVideoPollPolicy())
			if err != nil {
				t.Fatal(err)
			}
			video, _ := result["video"].(map[string]interface{})
			_, binary, err := DecodeProviderDataURL(stringField(video, "dataUrl"))
			if err != nil || len(binary) < 1000 {
				t.Fatalf("no usable video bytes: size=%d error=%v", len(binary), err)
			}
			if err := os.WriteFile(filepath.Join(filepath.Dir(infoPath), tc.name+".mp4"), binary, 0600); err != nil {
				t.Fatal(err)
			}
			t.Logf("saved %s.mp4 (%d bytes), through desktop H3 create→poll→authenticated content download", tc.name, len(binary))
		})
	}
	// Re-open the accepted task through the resumed production generation path.
	// The gateway's four-create cap makes accidental regeneration fail loudly.
	resume := WithCallMeta(ctx, CallMeta{ProviderRequestID: "h3-canary-1"})
	_, err = RunVideoTaskWithPolicy(resume, Input{Mode: "video", Config: Config{BaseURL: info.BaseURL, APIKey: info.Token, InterfaceType: "newapi-channel-2", Model: "minimax-h3-max-turbo", VQuality: "768", VideoSeconds: "3"}}, DefaultVideoPollPolicy())
	if err != nil {
		t.Fatal("accepted-task recovery failed:", err)
	}
}
func h3SyntheticFrame(t *testing.T, end bool) string {
	img := image.NewRGBA(image.Rect(0, 0, 768, 512))
	for y := 0; y < 512; y++ {
		for x := 0; x < 768; x++ {
			c := color.RGBA{172, 211, 211, 255}
			cx := 210
			if end {
				cx = 540
			}
			if (x-cx)*(x-cx)+(y-290)*(y-290) < 80*80 {
				c = color.RGBA{217, 55, 55, 255}
			}
			img.SetRGBA(x, y, c)
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(out.Bytes())
}
func h3SyntheticAudio() string {
	const rate = 16000
	const samples = 35200
	var out bytes.Buffer
	out.WriteString("RIFF")
	binary.Write(&out, binary.LittleEndian, uint32(36+samples*2))
	out.WriteString("WAVEfmt ")
	binary.Write(&out, binary.LittleEndian, uint32(16))
	binary.Write(&out, binary.LittleEndian, uint16(1))
	binary.Write(&out, binary.LittleEndian, uint16(1))
	binary.Write(&out, binary.LittleEndian, uint32(rate))
	binary.Write(&out, binary.LittleEndian, uint32(rate*2))
	binary.Write(&out, binary.LittleEndian, uint16(2))
	binary.Write(&out, binary.LittleEndian, uint16(16))
	out.WriteString("data")
	binary.Write(&out, binary.LittleEndian, uint32(samples*2))
	for i := 0; i < samples; i++ {
		binary.Write(&out, binary.LittleEndian, int16(3500*math.Sin(2*math.Pi*440*float64(i)/rate)))
	}
	return "data:audio/wav;base64," + base64.StdEncoding.EncodeToString(out.Bytes())
}
