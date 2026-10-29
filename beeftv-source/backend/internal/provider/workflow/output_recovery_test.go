package workflow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

type renewOutputPoller struct{ immediatePoller }

func (renewOutputPoller) Download(ctx context.Context, _ string, _ PollPolicy, source BinarySource, renew func(context.Context) (BinarySource, error)) ([]byte, string, error) {
	data, mimeType, err := source.Read(ctx)
	if err == nil || renew == nil {
		return data, mimeType, err
	}
	fresh, err := renew(ctx)
	if err != nil {
		return nil, "", err
	}
	return fresh.Read(ctx)
}

func outputRecoveryConfig() Config {
	return Config{InterfaceType: string(model.ChannelInterfaceRunningHubVideo), BaseURL: "https://workflow.example", APIKey: "fixture-key", Model: "fixture-workflow"}
}

func outputRecoveryJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func outputRecoveryMP4(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("../../app/testdata/reference-fragmented-30fps.mp4")
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func assertOriginalOutputRequest(t *testing.T, req Request) {
	t.Helper()
	var body map[string]any
	if req.Method != http.MethodPost || req.URL != "https://workflow.example/task/openapi/outputs" || json.Unmarshal(req.Body, &body) != nil || body["taskId"] != "original" || body["apiKey"] != "fixture-key" {
		t.Fatal("recovery must only query the original RunningHub task")
	}
}

func TestRunningHubOutputFieldsAreStableAndDistinctURLsSurvive(t *testing.T) {
	var body map[string]any
	if err := json.Unmarshal([]byte(`{"images":[{"fileUrl":"https://media.example/image.png"}],"videos":[{"outputId":"movie","fileUrl":"https://media.example/a.mp4","downloadUrl":"https://media.example/b.mp4","url":"https://media.example/a.mp4"}]}`), &body); err != nil {
		t.Fatal(err)
	}
	want := []string{"https://media.example/image.png", "https://media.example/b.mp4", "https://media.example/a.mp4"}
	for i := 0; i < 100; i++ {
		if got := OutputURLs(body); !reflect.DeepEqual(got, want) {
			t.Fatalf("output ordering/dedup changed: %v", got)
		}
	}
	outputs := runningHubOutputs(body)
	if outputs[1].ID != "movie" || outputs[2].ID != "movie" || outputs[1].Field != "/downloadurl" || outputs[2].Field != "/fileurl" || outputs[1].Owner != "/videos/0" {
		t.Fatalf("output identity lost: %#v", outputs)
	}
}

func TestRunningHubRenewalMatchesReorderedOutputIDsAcrossMedia(t *testing.T) {
	mp4 := outputRecoveryMP4(t)
	png := []byte("\x89PNG\r\n\x1a\nfixture")
	queries := 0
	var reads []string
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if req.Kind == "poll" {
			assertOriginalOutputRequest(t, req)
			queries++
			videos := []any{map[string]any{"id": "a", "fileUrl": "https://media.example/old-a.mp4"}, map[string]any{"id": "b", "fileUrl": "https://media.example/old-b.mp4"}}
			if queries > 1 {
				videos = []any{map[string]any{"id": "b", "fileUrl": "https://media.example/new-b.mp4"}, map[string]any{"id": "a", "fileUrl": "https://media.example/new-a.mp4"}}
			}
			return outputRecoveryJSON(t, map[string]any{"code": 0, "data": map[string]any{"taskId": "original", "videos": videos, "images": []any{map[string]any{"fileUrl": "https://media.example/picture.png"}}}}), "application/json", nil
		}
		if req.Kind != "download" || req.Method != http.MethodGet {
			t.Fatal("query/recovery entered create, upload, or schema discovery")
		}
		reads = append(reads, req.URL)
		if strings.Contains(req.URL, "/old-") {
			return nil, "", StatusError{StatusCode: http.StatusForbidden}
		}
		if strings.HasSuffix(req.URL, "/picture.png") {
			return png, "application/octet-stream", nil
		}
		return mp4, "application/octet-stream", nil
	}}
	result, stage, err := productionClient(exec, renewOutputPoller{}).QueryVideo(context.Background(), outputRecoveryConfig(), "https://workflow.example", "original")
	if err != nil || stage != "succeeded" || result["mode"] != "video" {
		t.Fatalf("stage=%s result=%v err=%v", stage, result, err)
	}
	want := []string{"https://media.example/picture.png", "https://media.example/old-a.mp4", "https://media.example/new-a.mp4", "https://media.example/old-b.mp4", "https://media.example/new-b.mp4"}
	if !reflect.DeepEqual(reads, want) || queries != 3 || len(result["images"].([]map[string]interface{})) != 1 {
		t.Fatalf("reads=%v queries=%d", reads, queries)
	}
	video := result["video"].(map[string]interface{})
	mimeType, data, err := decodeDataURL(video["dataUrl"].(string))
	if err != nil || mimeType != "video/mp4" || !bytes.Equal(data, mp4) {
		t.Fatal("recovered video bytes or MIME differ")
	}
}

func TestRunningHubLegacyRenewalMatchesAssetPathAfterReorder(t *testing.T) {
	queries := 0
	var reads []string
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if req.Kind == "poll" {
			assertOriginalOutputRequest(t, req)
			queries++
			urls := []string{"/a.mp4?signature=old", "/b.mp4?signature=old"}
			if queries > 1 {
				urls = []string{"/b.mp4?signature=new", "/a.mp4?signature=new"}
			}
			return outputRecoveryJSON(t, map[string]any{"code": 0, "data": []any{map[string]any{"fileUrl": "https://media.example" + urls[0]}, map[string]any{"fileUrl": "https://media.example" + urls[1]}}}), "application/json", nil
		}
		reads = append(reads, req.URL)
		if strings.HasSuffix(req.URL, "signature=old") {
			return nil, "", StatusError{StatusCode: http.StatusForbidden}
		}
		return []byte("video fixture"), "video/mp4", nil
	}}
	_, _, err := productionClient(exec, renewOutputPoller{}).QueryVideo(context.Background(), outputRecoveryConfig(), "https://workflow.example", "original")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://media.example/a.mp4?signature=old", "https://media.example/a.mp4?signature=new", "https://media.example/b.mp4?signature=old", "https://media.example/b.mp4?signature=new"}
	if !reflect.DeepEqual(reads, want) || queries != 3 {
		t.Fatalf("renewed wrong legacy artifact: %v queries=%d", reads, queries)
	}
}

func TestRunningHubRenewalRejectsMissingAndAmbiguousIdentityBeforeMediaRead(t *testing.T) {
	for _, tc := range []struct {
		name, initial, fresh string
	}{
		{"missing explicit ID", `[{"id":"a","fileUrl":"https://media.example/old.mp4"}]`, `[{"id":"b","fileUrl":"https://media.example/new.mp4"}]`},
		{"explicit ID removed", `[{"id":"a","fileUrl":"https://media.example/old.mp4"}]`, `[{"fileUrl":"https://media.example/old.mp4?signature=new"}]`},
		{"duplicate explicit ID", `[{"id":"a","fileUrl":"https://media.example/old.mp4"}]`, `[{"id":"a","fileUrl":"https://media.example/new.mp4"},{"id":"a","downloadUrl":"https://media.example/other.mp4"}]`},
		{"legacy original missing", `[{"fileUrl":"https://media.example/old.mp4"}]`, `[{"fileUrl":"https://media.example/other.mp4"}]`},
		{"legacy resource query changed", `[{"fileUrl":"https://media.example/download?asset=a&signature=old"}]`, `[{"fileUrl":"https://media.example/download?asset=b&signature=new"}]`},
		{"legacy path ambiguous", `[{"fileUrl":"https://media.example/download?asset=a&signature=old"}]`, `[{"fileUrl":"https://media.example/download?asset=a&signature=new1"},{"fileUrl":"https://media.example/download?asset=a&signature=new2"}]`},
		{"wrong task on renewal", `[{"id":"a","fileUrl":"https://media.example/old.mp4"}]`, `[{"id":"a","fileUrl":"https://media.example/new.mp4"}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			queries, reads := 0, 0
			exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
				if req.Kind == "poll" {
					assertOriginalOutputRequest(t, req)
					queries++
					body := tc.initial
					id := "original"
					if queries > 1 {
						body = tc.fresh
						if tc.name == "wrong task on renewal" {
							id = "other"
						}
					}
					return []byte(`{"code":0,"taskId":"` + id + `","data":` + body + `}`), "application/json", nil
				}
				reads++
				if reads > 1 {
					t.Error("identity mismatch must not fetch any renewed media")
				}
				return nil, "", StatusError{StatusCode: http.StatusForbidden}
			}}
			result, _, err := productionClient(exec, renewOutputPoller{}).QueryVideo(context.Background(), outputRecoveryConfig(), "https://workflow.example", "original")
			if err == nil || result != nil || reads != 1 || queries != 2 {
				t.Fatalf("result=%v err=%v queries=%d reads=%d", result, err, queries, reads)
			}
		})
	}
}

func TestRunningHubRenewalKeepsDistinctAliasURLsAndActualMIME(t *testing.T) {
	queries := 0
	var reads []string
	png := []byte("\x89PNG\r\n\x1a\nfixture")
	mp4 := outputRecoveryMP4(t)
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if req.Kind == "poll" {
			assertOriginalOutputRequest(t, req)
			queries++
			fileURL, downloadURL := "https://media.example/old-video.png", "https://media.example/old-image.mp4"
			if queries > 1 {
				fileURL, downloadURL = "https://media.example/video.mp4?signature=new", "https://media.example/image.png?signature=new"
			}
			return outputRecoveryJSON(t, map[string]any{"code": 0, "data": []any{map[string]any{"outputId": "alias-owner", "fileUrl": fileURL, "downloadUrl": downloadURL}}}), "application/json", nil
		}
		reads = append(reads, req.URL)
		if strings.Contains(req.URL, "/old-") {
			return nil, "", StatusError{StatusCode: http.StatusForbidden}
		}
		if strings.Contains(req.URL, "/image.png") {
			return png, "application/octet-stream", nil
		}
		return mp4, "application/octet-stream", nil
	}}
	result, _, err := productionClient(exec, renewOutputPoller{}).QueryVideo(context.Background(), outputRecoveryConfig(), "https://workflow.example", "original")
	if err != nil || result["mode"] != "video" || len(result["images"].([]map[string]interface{})) != 1 {
		t.Fatalf("result=%v err=%v", result, err)
	}
	want := []string{"https://media.example/old-image.mp4", "https://media.example/image.png?signature=new", "https://media.example/old-video.png", "https://media.example/video.mp4?signature=new"}
	if !reflect.DeepEqual(reads, want) || queries != 3 {
		t.Fatalf("alias identity changed: %v queries=%d", reads, queries)
	}
	if result["images"].([]map[string]interface{})[0]["mimeType"] != "image/png" || result["video"].(map[string]interface{})["mimeType"] != "video/mp4" {
		t.Fatal("MIME was taken from the expired URL instead of actual bytes/source")
	}
}

func TestRunningHubWrongTaskIDRejectsAllOutputReads(t *testing.T) {
	for _, identity := range []string{`"taskId":"other"`, `"task_id":"other"`, `"taskID":"other"`, `"id":"other"`, `"id":"other","url":null`} {
		t.Run(identity, func(t *testing.T) {
			exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
				if req.Kind != "poll" {
					t.Fatal("wrong task ID must cause zero media reads")
				}
				assertOriginalOutputRequest(t, req)
				return []byte(`{"code":0,"data":{` + identity + `,"videos":[{"id":"artifact","fileUrl":"https://media.example/video.mp4"}]}}`), "application/json", nil
			}}
			result, _, err := productionClient(exec, renewOutputPoller{}).QueryVideo(context.Background(), outputRecoveryConfig(), "https://workflow.example", "original")
			if err == nil || result != nil || len(exec.paths()) != 1 {
				t.Fatalf("result=%v err=%v calls=%d", result, err, len(exec.paths()))
			}
		})
	}
}

func TestRunningHubOutputObjectIDIsNotTaskIDAndResolvedURLsDeduplicate(t *testing.T) {
	for _, data := range []string{`{"id":"artifact","fileUrl":"/output/video.mp4","downloadUrl":"https://workflow.example/output/video.mp4"}`, `[{"id":"artifact","fileUrl":"/output/video.mp4","downloadUrl":"https://workflow.example/output/video.mp4"}]`} {
		reads := 0
		exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
			if req.Kind == "poll" {
				return []byte(`{"code":0,"data":` + data + `}`), "application/json", nil
			}
			reads++
			return []byte("video fixture"), "video/mp4", nil
		}}
		result, _, err := productionClient(exec).QueryVideo(context.Background(), outputRecoveryConfig(), "https://workflow.example", "original")
		if err != nil || result["mode"] != "video" || reads != 1 {
			t.Fatalf("result=%v err=%v reads=%d", result, err, reads)
		}
	}
}

func TestRunningHubCancellationDoesNotQueryRenewalOrCreate(t *testing.T) {
	for _, beforeQuery := range []bool{true, false} {
		ctx, cancel := context.WithCancel(context.Background())
		if beforeQuery {
			cancel()
		}
		queries, reads := 0, 0
		exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
			if req.Kind == "poll" {
				assertOriginalOutputRequest(t, req)
				queries++
				return []byte(`{"code":0,"data":[{"fileUrl":"https://media.example/old.mp4"}]}`), "application/json", nil
			}
			reads++
			cancel()
			return nil, "", StatusError{StatusCode: http.StatusForbidden}
		}}
		result, _, err := productionClient(exec, renewOutputPoller{}).QueryVideo(ctx, outputRecoveryConfig(), "https://workflow.example", "original")
		cancel()
		want := 1
		if beforeQuery {
			want = 0
		}
		if !errors.Is(err, context.Canceled) || result != nil || queries != want || reads != want {
			t.Fatalf("before=%v result=%v err=%v queries=%d reads=%d", beforeQuery, result, err, queries, reads)
		}
	}
}
