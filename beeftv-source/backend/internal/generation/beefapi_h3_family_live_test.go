package generation

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Explicit production opt-in. Max text and base multimodal references each
// submit once. Base 2K keyframes are reserved for installed-client acceptance.
// Intent files prevent reruns from creating another paid request after an
// unknown response; accepted IDs can instead resume the original task.
func TestBeefAPIH3FamilyProductionCanary(t *testing.T) {
	key, dir := os.Getenv("FAL_H3_FAMILY_LIVE_TOKEN"), os.Getenv("FAL_H3_FAMILY_LIVE_DIR")
	if key == "" || dir == "" {
		t.Skip("explicit paid family acceptance opt-in required")
	}
	if !filepath.IsAbs(dir) {
		t.Fatal("acceptance directory must be absolute")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	// Includes previous calls, the supplier-cost uncertainty reserve and the
	// planned native 5-second base 2K request. This ceiling is shared, not reset.
	if 7.10326+6.611865+3.356793+2.170048 > 20 {
		t.Fatal("shared real-test budget exceeded")
	}
	videoPath := os.Getenv("FAL_H3_FAMILY_REFERENCE_VIDEO")
	videoBytes, err := os.ReadFile(videoPath)
	if err != nil {
		t.Fatal(err)
	}
	first, last := h3SyntheticFrame(t, false), h3SyntheticFrame(t, true)
	for name, value := range map[string]string{"first": first, "last": last} {
		_, bytes, err := DecodeProviderDataURL(value)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, name+".png"), bytes, 0600); err != nil {
			t.Fatal(err)
		}
	}
	images := []Media{}
	for i := 0; i < 6; i++ {
		images = append(images, Media{ID: fmt.Sprintf("ref-%d", i), DataURL: h3SyntheticFrame(t, i%2 == 1)})
	}
	cases := []struct {
		name, model, seconds, resolution string
		upper                            float64
		images, videos, audios           []Media
	}{
		{"max-text-768p", "minimax-h3-max", "3", "768", 2.170048, nil, nil, nil},
		{"base-reference-480p", "minimax-h3", "5", "480", 3.356793, images, []Media{{ID: "video", DataURL: DataURL("video/mp4", videoBytes)}}, []Media{{ID: "audio", DataURL: h3SyntheticAudio()}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name+"-intent.json")
			recorder := &h3FamilyProductionRecorder{path: path, t: t, record: map[string]any{"case": tc.name, "model": tc.model, "seconds": tc.seconds, "resolution": tc.resolution, "budget_upper_cny": tc.upper, "method": "production-go-test", "created": false}}
			resume := ""
			if existing, err := os.ReadFile(path); err == nil {
				if os.Getenv("FAL_H3_FAMILY_RESUME") != "1" || json.Unmarshal(existing, &recorder.record) != nil {
					t.Fatal("an earlier paid attempt exists; query its original task instead of creating again")
				}
				resume, _ = recorder.record["gateway_task_id"].(string)
				if resume == "" {
					t.Fatal("earlier submission outcome unknown; do not resend")
				}
			} else if !os.IsNotExist(err) {
				t.Fatal(err)
			} else {
				file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
				if err != nil {
					t.Fatal(err)
				}
				data, _ := json.Marshal(recorder.record)
				_, writeErr := file.Write(data)
				closeErr := file.Close()
				if writeErr != nil {
					t.Fatal(writeErr)
				}
				if closeErr != nil {
					t.Fatal(closeErr)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
			defer cancel()
			ctx = WithRuntime(ctx, Runtime{Receipts: recorder, Call: CallMeta{TaskID: "h3-family-20261013-" + tc.name, ProviderRequestID: resume}})
			input := Input{Mode: "video", Prompt: "A small red paper ball rolls gently across a pale teal tabletop. Follow the reference ball and motion, one continuous shot, soft daylight, fixed camera, no text.", Config: Config{BaseURL: "https://beeftv.app/v1", APIKey: key, InterfaceType: "newapi-channel-2", Model: tc.model, VideoSeconds: tc.seconds, VQuality: tc.resolution, Size: "16:9"}, ReferenceImages: tc.images, ReferenceVideos: tc.videos, ReferenceAudios: tc.audios}
			result, err := RunVideoTaskWithPolicy(ctx, input, DefaultVideoPollPolicy())
			if err != nil {
				t.Fatal(err)
			}
			video, _ := result["video"].(map[string]interface{})
			_, data, err := DecodeProviderDataURL(stringField(video, "dataUrl"))
			if err != nil || len(data) < 1000 {
				t.Fatalf("no playable result bytes: %v", err)
			}
			if err = os.WriteFile(filepath.Join(dir, tc.name+".mp4"), data, 0600); err != nil {
				t.Fatal(err)
			}
			recorder.record["bytes"], recorder.record["sha256"], recorder.record["saved"] = len(data), fmt.Sprintf("%x", sha256.Sum256(data)), true
			recorder.save()
			t.Logf("saved %s: %d bytes; original gateway task %v", tc.name, len(data), recorder.record["gateway_task_id"])
		})
	}
}

type h3FamilyProductionRecorder struct {
	t      *testing.T
	path   string
	record map[string]any
}

func (r *h3FamilyProductionRecorder) save() {
	data, err := json.Marshal(r.record)
	if err != nil {
		r.t.Error(err)
		return
	}
	if err = os.WriteFile(r.path, data, 0600); err != nil {
		r.t.Error(err)
	}
}
func (r *h3FamilyProductionRecorder) Observe(o TransportObservation) {
	if o.Request == nil || o.Request.Method != "POST" || !strings.HasSuffix(o.Request.URL.Path, "/videos") {
		return
	}
	var response map[string]any
	if json.Unmarshal(o.Body, &response) != nil {
		return
	}
	if data, ok := response["data"].(map[string]any); ok {
		response = data
	}
	if id, ok := response["id"].(string); ok && id != "" {
		r.record["gateway_task_id"], r.record["created"] = id, true
		r.save()
	}
}
func (*h3FamilyProductionRecorder) NotifyPoll(context.Context, string, error) {}
func (*h3FamilyProductionRecorder) SyncProgress(string, []byte)               {}
