package handler

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"strings"
	"testing"
)

func TestAssistantRenderOutputsUseRealAdmissionsOnCancelledTerminalAndHistory(t *testing.T) {
	for _, terminal := range []string{"cancelled", "model_error"} {
		t.Run(terminal, func(t *testing.T) {
			var turnID string
			var taskIDs []string
			env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/history" {
						_ = json.NewEncoder(w).Encode(map[string]any{"turns": []any{
							map[string]any{"turnId": turnID, "outputs": []any{map[string]any{"taskId": "host-forged-task"}}},
							map[string]any{"turnId": "deadbeefdeadbeef", "outputs": []any{map[string]any{"taskId": "other-turn-task"}}},
						}})
						return
					}
					if r.URL.Path != "/chat" {
						w.WriteHeader(404)
						return
					}
					var body struct {
						TurnID         string `json:"turnId"`
						RevisionBefore int64  `json:"revisionBefore"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						w.WriteHeader(400)
						return
					}
					turnID = body.TurnID
					params, _ := json.Marshal(map[string]any{"canvasId": env.canvasID, "expectedRevision": body.RevisionBefore, "options": map[string]any{"width": 64, "height": 64, "fps": 24}})
					for _, opID := range []string{"first-render", "first-render", "repair-render"} {
						code, result := env.opsRaw("canvas.timeline.render", opID, turnID, string(params))
						if code != 200 {
							t.Errorf("actual admission failed: %d %s", code, result)
							w.WriteHeader(500)
							return
						}
						var out struct {
							Data struct {
								Result struct {
									TaskID string `json:"taskId"`
								} `json:"result"`
							} `json:"data"`
						}
						if json.Unmarshal([]byte(result), &out) != nil || out.Data.Result.TaskID == "" {
							t.Errorf("missing render: %s", result)
							w.WriteHeader(500)
							return
						}
						if len(taskIDs) == 0 || taskIDs[len(taskIDs)-1] != out.Data.Result.TaskID {
							taskIDs = append(taskIDs, out.Data.Result.TaskID)
						}
					}
					w.Header().Set("Content-Type", "application/x-ndjson")
					_ = json.NewEncoder(w).Encode(map[string]any{"type": "turn_end", "turnId": turnID, "cancelled": terminal == "cancelled", "error": terminal, "outputs": []any{map[string]any{"taskId": "host-forged-task"}}})
				})
			})
			owner, err := env.service.LocalWorkspaceOwner()
			if err != nil {
				t.Fatal(err)
			}
			img := image.NewRGBA(image.Rect(0, 0, 16, 16))
			for y := 0; y < 16; y++ {
				for x := 0; x < 16; x++ {
					img.Set(x, y, color.RGBA{R: 50, G: 100, B: 200, A: 255})
				}
			}
			var pngBytes bytes.Buffer
			if err = png.Encode(&pngBytes, img); err != nil {
				t.Fatal(err)
			}
			resource, err := env.service.UploadLocalResourceFile(owner.ID, "fixture.png", int64(pngBytes.Len()), "image", 16, 16, 0, bytes.NewReader(pngBytes.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			asset, _ := json.Marshal(map[string]any{"id": "fixture-asset", "kind": "image", "title": "Fixture", "tags": []string{}, "coverUrl": "/api/resources/" + resource.ID + "/file", "data": map[string]any{"dataUrl": "/api/resources/" + resource.ID + "/file", "storageKey": "resource:" + resource.ID, "width": 16, "height": 16, "bytes": pngBytes.Len(), "mimeType": "image/png"}})
			if _, err := env.service.UpsertUserAsset(owner.ID, asset); err != nil {
				t.Fatal(err)
			}
			revision, err := env.canvasRevisionQuiet()
			if err != nil {
				t.Fatal(err)
			}
			doc, _ := json.Marshal(map[string]any{"id": env.canvasID, "revision": revision, "nodes": []any{map[string]any{"id": "image-node", "type": "image", "metadata": map[string]any{"assetId": "fixture-asset", "storageKey": "resource:" + resource.ID}}}, "connections": []any{}, "timeline": map[string]any{"version": 2, "durationMs": 1000, "tracks": []any{map[string]any{"id": "video-track", "kind": "video"}}, "clips": []any{map[string]any{"id": "clip", "kind": "image", "nodeId": "image-node", "trackId": "video-track", "durationMs": 1000, "startMs": 0, "directMedia": map[string]any{"id": resource.ID, "assetId": "fixture-asset", "kind": "image", "storageKey": "resource:" + resource.ID}}}}})
			if _, err = env.service.UpsertUserCanvasProject(owner.ID, doc); err != nil {
				t.Fatal(err)
			}
			response := env.call(t, http.MethodPost, "/assistant/chat", `{"canvasId":"`+env.canvasID+`","message":"render existing timeline"}`)
			if response.Code != 200 || len(taskIDs) != 2 {
				t.Fatalf("chat failed: %d %s tasks%v", response.Code, response.Body.String(), taskIDs)
			}
			var end map[string]any
			for _, line := range strings.Split(response.Body.String(), "\n") {
				var value map[string]any
				if json.Unmarshal([]byte(line), &value) == nil && value["type"] == "turn_end" {
					end = value
				}
			}
			assertOutputs := func(value any) {
				t.Helper()
				rows, ok := value.([]any)
				if !ok || len(rows) != 2 {
					t.Fatalf("missing trusted outputs: %#v", value)
				}
				for i, row := range rows {
					x := row.(map[string]any)
					if x["taskId"] != taskIDs[i] || x["kind"] != "video" || x["sourceRevision"] == nil {
						t.Fatalf("wrong projection: %#v", x)
					}
				}
			}
			assertOutputs(end["outputs"])
			for _, id := range taskIDs {
				task, err := env.service.Task(owner.ID, id)
				if err != nil || string(task.Status) != "queued" || task.Provider != "local" {
					t.Fatalf("receipt incorrectly implied ready/paid: %#v %v", task, err)
				}
			}
			history := decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/history?canvasId="+env.canvasID, ""))
			turns := history["turns"].([]any)
			assertOutputs(turns[0].(map[string]any)["outputs"])
			if len(turns[1].(map[string]any)["outputs"].([]any)) != 0 {
				t.Fatal("unknown host turn expanded outputs")
			}
			foreign := assistantOutputsLine([]byte(`{"type":"turn_end","turnId":"other","outputs":[{"taskId":"host-forged-task"}]}`), env.service, owner.ID, env.canvasID, turnID)
			var stripped map[string]any
			if json.Unmarshal(foreign, &stripped) != nil || len(stripped["outputs"].([]any)) != 0 {
				t.Fatalf("foreign terminal retained outputs: %s", foreign)
			}
		})
	}
}
