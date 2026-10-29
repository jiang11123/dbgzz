package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func TestBeefAPISeedancePreuploadConvertsInlineRefsAndPreservesOrder(t *testing.T) {
	imagePayload := []byte("small-png-bytes")
	videoPayload := syntheticVideoMP4(1280, 720, 3200)
	audioPayload := []byte("id3-audio")
	harness := newBeefAPISeedanceUploadHarness(t)
	input := harness.testInput(
		providerMedia{ID: "img-1", DataURL: dataURL("image/png", imagePayload), MimeType: "image/png", Width: 800, Height: 800},
		providerMedia{ID: "vid-1", DataURL: dataURL("video/mp4", videoPayload), MimeType: "video/mp4", DurationMs: 3200},
		providerMedia{ID: "aud-1", DataURL: dataURL("audio/mpeg", audioPayload), MimeType: "audio/mpeg", DurationMs: 1800},
	)
	if err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, nil); err != nil {
		t.Fatal(err)
	}
	if harness.generates != 0 {
		t.Fatalf("generation posted during prepare: %d", harness.generates)
	}
	if harness.creates != 3 || harness.puts != 3 || harness.completes != 3 {
		t.Fatalf("transport counts create=%d put=%d complete=%d", harness.creates, harness.puts, harness.completes)
	}
	if got := input.ReferenceImages[0].URL; !strings.HasPrefix(got, harness.server.URL+"/named/") || input.ReferenceImages[0].DataURL != "" {
		t.Fatalf("image URL = %#v", input.ReferenceImages[0])
	}
	if got := input.ReferenceVideos[0].URL; !strings.HasPrefix(got, harness.server.URL+"/named/") || input.ReferenceVideos[0].DataURL != "" {
		t.Fatalf("video URL = %#v", input.ReferenceVideos[0])
	}
	if got := input.ReferenceAudios[0].URL; !strings.HasPrefix(got, harness.server.URL+"/named/") || input.ReferenceAudios[0].DataURL != "" {
		t.Fatalf("audio URL = %#v", input.ReferenceAudios[0])
	}
	if input.ReferenceImages[0].StorageKey != "" || input.ReferenceVideos[0].StorageKey != "" || input.ReferenceAudios[0].StorageKey != "" {
		t.Fatalf("storage keys left after rewrite: image=%#v video=%#v audio=%#v", input.ReferenceImages[0], input.ReferenceVideos[0], input.ReferenceAudios[0])
	}
	if input.ReferenceImages[0].Width != 800 || input.ReferenceVideos[0].Width != 1280 || input.ReferenceVideos[0].Height != 720 || input.ReferenceVideos[0].DurationMs != 3200 || input.ReferenceAudios[0].DurationMs != 1800 {
		t.Fatalf("metadata lost: image=%#v video=%#v audio=%#v", input.ReferenceImages[0], input.ReferenceVideos[0], input.ReferenceAudios[0])
	}
	if input.ReferenceImages[0].Bytes != int64(len(imagePayload)) || input.ReferenceVideos[0].Bytes != int64(len(videoPayload)) {
		t.Fatalf("byte sizes overwritten: image=%d video=%d", input.ReferenceImages[0].Bytes, input.ReferenceVideos[0].Bytes)
	}
	if len(harness.createBodies) != 3 {
		t.Fatalf("create bodies = %d", len(harness.createBodies))
	}
	want := []struct {
		kind    string
		payload []byte
		mime    string
	}{
		{"image", imagePayload, "image/png"},
		{"video", videoPayload, "video/mp4"},
		{"audio", audioPayload, "audio/mpeg"},
	}
	for i, item := range want {
		body := harness.createBodies[i]
		sum := sha256.Sum256(item.payload)
		if body.Kind != item.kind || body.Mime != item.mime || body.Bytes != int64(len(item.payload)) || body.SHA256 != hex.EncodeToString(sum[:]) {
			t.Fatalf("create[%d] = %#v, want kind=%s mime=%s bytes=%d", i, body, item.kind, item.mime, len(item.payload))
		}
		put := harness.putsByTicket[body.Kind]
		if put.auth != "" || strings.Contains(strings.ToLower(put.headers.Get("Authorization")), "secret-key") {
			t.Fatalf("PUT leaked auth: %#v", put)
		}
		if put.headers.Get("Content-Type") != item.mime || put.headers.Get("X-Amz-Meta-Test") != "1" {
			t.Fatalf("PUT missing required headers: %v", put.headers)
		}
		if put.length != int64(len(item.payload)) || !bytes.Equal(put.body, item.payload) {
			t.Fatalf("PUT body mismatch kind=%s len=%d", item.kind, put.length)
		}
	}
	body, err := beefAPIVideoRequestBody(input)
	if err != nil {
		t.Fatal(err)
	}
	content := body["content"].([]map[string]interface{})
	if len(content) != 3 {
		t.Fatalf("content = %#v", content)
	}
	if content[0]["type"] != "image_url" || content[0]["role"] != "reference_image" {
		t.Fatalf("image role/order lost: %#v", content[0])
	}
	if content[1]["type"] != "video_url" || content[1]["role"] != "reference_video" {
		t.Fatalf("video role/order lost: %#v", content[1])
	}
	if content[2]["type"] != "audio_url" || content[2]["role"] != "reference_audio" {
		t.Fatalf("audio role/order lost: %#v", content[2])
	}
	metadata := body["metadata"].(map[string]interface{})
	if body["generate_audio"] != nil || metadata["generate_audio"] != false || metadata["watermark"] != false {
		t.Fatalf("boolean false lost: %#v", body)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(encoded)) > videoJSONRequestLimitBytes {
		t.Fatalf("URL-only body still over 64MiB: %d", len(encoded))
	}
	if strings.Contains(string(encoded), "data:") {
		t.Fatalf("generation JSON still inlined data: %s", encoded)
	}
}

// The shared upload stage preserves order; model reference counts are checked
// separately, and this does not enable multiple references for Wan.
func TestBeefAPIWanPreuploadPreservesMixedReferenceOrder(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	input := harness.testInput(providerMedia{}, providerMedia{}, providerMedia{})
	input.Config.Model, input.Config.InterfaceType = "wan3.0-video", "newapi-channel-2"
	input.ReferenceImages = []providerMedia{
		{ID: "first", DataURL: dataURL("image/png", []byte("first")), Width: 720, Height: 1280},
		{ID: "remote", URL: "https://media.example/remote.png"},
		{ID: "last", DataURL: dataURL("image/png", []byte("last")), Width: 1280, Height: 720},
	}
	if err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, nil); err != nil {
		t.Fatal(err)
	}
	if harness.creates != 2 || harness.puts != 2 || harness.completes != 2 {
		t.Fatalf("unexpected upload count: %d/%d/%d", harness.creates, harness.puts, harness.completes)
	}
	for i, id := range []string{"first", "remote", "last"} {
		if input.ReferenceImages[i].ID != id {
			t.Fatalf("reference %d changed identity", i)
		}
	}
	if input.ReferenceImages[1].URL != "https://media.example/remote.png" || input.ReferenceImages[0].Width != 720 || input.ReferenceImages[2].Width != 1280 || input.ReferenceImages[0].DataURL != "" || input.ReferenceImages[2].DataURL != "" {
		t.Fatal("reference metadata or existing URL changed")
	}
	for i, payload := range []string{"first", "last"} {
		sum := sha256.Sum256([]byte(payload))
		if harness.createBodies[i].SHA256 != hex.EncodeToString(sum[:]) {
			t.Fatalf("upload %d changed reference order", i)
		}
	}
}

func TestBeefAPISeedancePreuploadSkipsPublicAndAssetURLs(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	input := harness.testInput(
		providerMedia{ID: "img-1", URL: "https://example.com/public.png", MimeType: "image/png"},
		providerMedia{ID: "vid-1", URL: "asset://ark-asset-1", MimeType: "video/mp4"},
		providerMedia{},
	)
	if err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, nil); err != nil {
		t.Fatal(err)
	}
	if harness.creates != 0 || harness.puts != 0 {
		t.Fatalf("public/asset URLs uploaded: create=%d put=%d", harness.creates, harness.puts)
	}
	if input.ReferenceImages[0].URL != "https://example.com/public.png" || input.ReferenceVideos[0].URL != "asset://ark-asset-1" {
		t.Fatalf("existing URLs rewritten: %#v %#v", input.ReferenceImages[0], input.ReferenceVideos[0])
	}
}

func TestBeefAPISeedancePreuploadRejectsMismatchedReceipt(t *testing.T) {
	for field, value := range map[string]interface{}{"kind": "video", "bytes": 1, "sha256": strings.Repeat("0", 64), "mime": "text/html"} {
		t.Run(field, func(t *testing.T) {
			harness := newBeefAPISeedanceUploadHarness(t)
			harness.mutateReceipt = func(receipt map[string]interface{}) { receipt[field] = value }
			input := harness.testInput(providerMedia{DataURL: dataURL("image/png", []byte("image-fixture"))}, providerMedia{}, providerMedia{})
			err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, nil)
			if !errors.Is(err, errBeefAPISeedanceUploadIncomplete) || input.ReferenceImages[0].URL != "" || harness.generates != 0 {
				t.Fatalf("mismatched receipt accepted: err=%v generates=%d", err, harness.generates)
			}
		})
	}
}

func TestBeefAPISeedancePreuploadLargeLocalReference(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	const size = 70 << 20
	payload := paddedSyntheticVideo(t, size)
	input := harness.testInput(providerMedia{}, providerMedia{StorageKey: "resource:large-video", MimeType: "video/mp4", Bytes: size}, providerMedia{})
	err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, func(string, providerMedia) ([]byte, string, bool, error) {
		return payload, "video/mp4", false, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	body, err := beefAPIVideoRequestBody(input)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(body)
	if err != nil || len(encoded) > 16<<10 || input.ReferenceVideos[0].Bytes != size || harness.putsByTicket["video"].length != size {
		t.Fatalf("large reference did not leave generation JSON: err=%v bytes=%d", err, len(encoded))
	}
}

func TestBeefAPISeedancePreuploadFallbackOnMissingEndpoint(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusNotImplemented} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			harness := newBeefAPISeedanceUploadHarness(t)
			harness.createStatus = status
			payload := []byte("tiny-image")
			input := harness.testInput(
				providerMedia{ID: "img-1", DataURL: dataURL("image/png", payload), MimeType: "image/png"},
				providerMedia{},
				providerMedia{},
			)
			if err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, nil); err != nil {
				t.Fatal(err)
			}
			if harness.puts != 0 || harness.completes != 0 || harness.generates != 0 {
				t.Fatalf("fallback used object upload put=%d complete=%d generate=%d", harness.puts, harness.completes, harness.generates)
			}
			if !strings.HasPrefix(input.ReferenceImages[0].DataURL, "data:image/png;base64,") {
				t.Fatalf("fallback lost inline data: %#v", input.ReferenceImages[0])
			}
		})
	}
}

func TestBeefAPISeedancePreuploadFallbackRejectsOversizeJSON(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	harness.createStatus = http.StatusNotFound
	readCalls := 0
	input := harness.testInput(
		providerMedia{},
		providerMedia{ID: "vid-1", StorageKey: "resource:huge-video", MimeType: "video/mp4", Bytes: 50 << 20},
		providerMedia{},
	)
	err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, func(kind string, media providerMedia) ([]byte, string, bool, error) {
		readCalls++
		return syntheticVideoMP4(1280, 720, 1000), "video/mp4", false, nil
	})
	if !errors.Is(err, errVideoJSONRequestTooLarge) {
		t.Fatalf("error = %v, want 64MiB bound", err)
	}
	if generation.ClassifyError(err).Category != generation.CategoryInputTooLarge {
		t.Fatalf("category = %s", generation.ClassifyError(err).Category)
	}
	if readCalls > 1 {
		t.Fatalf("fallback re-read the oversize file %d times", readCalls)
	}
	if harness.puts != 0 || harness.generates != 0 {
		t.Fatalf("oversize fallback reached network put=%d generate=%d", harness.puts, harness.generates)
	}
}

func TestBeefAPISeedancePreuploadCompleteErrorPreventsGenerate(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	harness.completeStatus = http.StatusBadRequest
	input := harness.testInput(
		providerMedia{ID: "img-1", DataURL: dataURL("image/png", []byte("png-bytes")), MimeType: "image/png"},
		providerMedia{},
		providerMedia{},
	)
	err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, nil)
	var upload *generation.ReferenceUploadError
	if !errors.As(err, &upload) || upload.Meta.Stage != "complete" || upload.Meta.Attempt != 1 || !strings.Contains(upload.Detail, "还没有收到文件，请先把文件传完再确认") {
		t.Fatalf("error = %v, want user-facing complete message", err)
	}
	if harness.generates != 0 || harness.completes != 1 {
		t.Fatal("generation posted after complete failure")
	}
	if harness.puts == 0 {
		t.Fatal("PUT not attempted before complete")
	}
}

func TestBeefAPISeedancePreuploadCompleteUnknown400KeepsDiagnostic(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	harness.completeStatus = http.StatusBadRequest
	harness.completeBody = []byte(`{"error":{"message":"ticket sha256 mismatch on r2 upload_url"}}`)
	input := harness.testInput(
		providerMedia{ID: "img-1", DataURL: dataURL("image/png", []byte("png-bytes")), MimeType: "image/png"},
		providerMedia{},
		providerMedia{},
	)
	err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, nil)
	var upload *generation.ReferenceUploadError
	if !errors.As(err, &upload) || upload.HTTPStatus != 400 || upload.Meta.Stage != "complete" || !strings.Contains(upload.Detail, "sha256 mismatch") {
		t.Fatalf("error = %v, want structured confirmation error", err)
	}
	if harness.generates != 0 {
		t.Fatal("generation posted after unknown complete 400")
	}
}

func TestBeefAPISeedancePreuploadCancelSkipsGenerate(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	harness := newBeefAPISeedanceUploadHarness(t)
	harness.putHook = func(http.ResponseWriter, *http.Request) {
		close(started)
		<-release
	}
	ctx, cancel := context.WithCancel(harness.ctx())
	defer cancel()
	input := harness.testInput(
		providerMedia{ID: "img-1", DataURL: dataURL("image/png", []byte("png-bytes")), MimeType: "image/png"},
		providerMedia{},
		providerMedia{},
	)
	errCh := make(chan error, 1)
	go func() {
		errCh <- prepareBeefAPISeedanceReferences(ctx, input.Config, &input, nil)
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("PUT did not start")
	}
	cancel()
	err := <-errCh
	close(release)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want canceled", err)
	}
	if harness.generates != 0 {
		t.Fatal("generation posted after cancel")
	}
}

func TestBeefAPISeedancePreuploadRejectsCreateErrorAfterStart(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	harness.failCreateAfter = 1
	input := harness.testInput(
		providerMedia{ID: "img-1", DataURL: dataURL("image/png", []byte("one")), MimeType: "image/png"},
		providerMedia{},
		providerMedia{ID: "aud-1", DataURL: dataURL("audio/mpeg", []byte("two")), MimeType: "audio/mpeg"},
	)
	err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, nil)
	if err == nil {
		t.Fatal("later create 404 silently fell back")
	}
	if harness.creates < 2 {
		t.Fatalf("creates = %d, want second create", harness.creates)
	}
	if !strings.HasPrefix(input.ReferenceImages[0].URL, harness.server.URL+"/named/") {
		t.Fatalf("first upload not kept: %#v", input.ReferenceImages[0])
	}
	if input.ReferenceAudios[0].URL != "" {
		t.Fatalf("second item completed after create failure: %#v", input.ReferenceAudios[0])
	}
	if harness.generates != 0 {
		t.Fatal("generation posted after later create failure")
	}
}

func TestBeefAPISeedancePreuploadRejectsRedirect(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	harness.redirectPut = true
	input := harness.testInput(
		providerMedia{ID: "img-1", DataURL: dataURL("image/png", []byte("png-bytes")), MimeType: "image/png"},
		providerMedia{},
		providerMedia{},
	)
	err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, nil)
	if err == nil || !errors.Is(err, errBeefAPISeedanceUploadUnavailable) {
		t.Fatalf("error = %v, want redirect rejection", err)
	}
	if harness.completes != 0 || harness.generates != 0 {
		t.Fatalf("redirect continued complete=%d generate=%d", harness.completes, harness.generates)
	}
}

func TestBeefAPISeedancePreuploadNoAuthOnPut(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	payload := []byte("png-bytes")
	input := harness.testInput(
		providerMedia{ID: "img-1", DataURL: dataURL("image/png", payload), MimeType: "image/png"},
		providerMedia{},
		providerMedia{},
	)
	input.Config.APIKey = "secret-key-do-not-leak"
	input.Config.Headers = []OutboundHeader{{Name: "X-Debug-Trace", Value: "should-not-be-on-put"}}
	if err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, nil); err != nil {
		t.Fatal(err)
	}
	put := harness.putsByTicket["image"]
	for _, values := range put.headers {
		for _, value := range values {
			if strings.Contains(value, "secret-key-do-not-leak") {
				t.Fatalf("PUT leaked API key: %v", put.headers)
			}
		}
	}
	if put.headers.Get("X-Debug-Trace") != "" {
		t.Fatalf("PUT copied channel headers: %v", put.headers)
	}
	if harness.createAuth == "" || !strings.Contains(harness.createAuth, "secret-key-do-not-leak") {
		t.Fatalf("create missing bearer auth: %q", harness.createAuth)
	}
	if harness.completeAuth == "" || !strings.Contains(harness.completeAuth, "secret-key-do-not-leak") {
		t.Fatalf("complete missing bearer auth: %q", harness.completeAuth)
	}
}

func TestBeefAPISeedancePreuploadCustomChannelUnchanged(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	payload := []byte("png-bytes")
	input := canvasGenerationInput{
		Mode:   "video",
		Prompt: "walk",
		Config: providerConfig{
			BaseURL:            harness.server.URL,
			APIKey:             "custom-key",
			Model:              "seedance-2.5",
			InterfaceType:      string(model.ChannelInterfaceNewAPIVideo),
			Size:               "16:9",
			VideoSeconds:       "5",
			VideoGenerateAudio: "false",
		},
		ReferenceImages: []providerMedia{{ID: "img-1", DataURL: dataURL("image/png", payload), MimeType: "image/png"}},
		Metadata:        map[string]interface{}{"videoEditOperation": "reference_to_video"},
	}
	if err := prepareBeefAPISeedanceReferences(context.Background(), input.Config, &input, nil); err != nil {
		t.Fatal(err)
	}
	if harness.creates != 0 {
		t.Fatalf("custom channel used preupload: %d", harness.creates)
	}
	body, err := beefAPIVideoRequestBody(input)
	if err != nil {
		t.Fatal(err)
	}
	content := body["content"].([]map[string]interface{})
	image, _ := content[0]["image_url"].(map[string]interface{})
	if !strings.HasPrefix(fmt.Sprint(image["url"]), "data:image/png;base64,") {
		t.Fatalf("custom channel inline image lost: %#v", image)
	}
}

func TestBeefAPISeedancePreuploadRejectsOversizedFileBeforeNetwork(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	readCalls := 0
	input := harness.testInput(
		providerMedia{ID: "img-1", StorageKey: "resource:too-big", MimeType: "image/png", Bytes: beefAPISeedanceImageMaxBytes + 1},
		providerMedia{},
		providerMedia{},
	)
	err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, func(kind string, media providerMedia) ([]byte, string, bool, error) {
		readCalls++
		return []byte("nope"), "image/png", false, nil
	})
	if err == nil || !strings.Contains(err.Error(), "30MB") {
		t.Fatalf("error = %v, want size rejection", err)
	}
	if readCalls != 0 || harness.creates != 0 {
		t.Fatalf("oversize reached IO/network read=%d create=%d", readCalls, harness.creates)
	}
}

func TestBeefAPISeedancePreuploadResolvesLocalResource(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	svc := newResourceTestService(t)
	localDir := filepath.Join(svc.dataDir, "resources", "users", "user-1", "image")
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		t.Fatal(err)
	}
	payload := []byte("local-png-bytes")
	if err := os.WriteFile(filepath.Join(localDir, "reference.png"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{
		ID: "beefapi-preupload-local", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/reference.png", MimeType: "image/png", Size: int64(len(payload)),
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	input := harness.testInput(
		providerMedia{ID: "img-1", StorageKey: "resource:beefapi-preupload-local", MimeType: "image/png"},
		providerMedia{},
		providerMedia{},
	)
	if err := svc.hydrateGenerationMedia("user-1", &input, providerMediaHydrationPolicyFor(harness.ctx(), input)); err != nil {
		t.Fatal(err)
	}
	if input.ReferenceImages[0].DataURL != "" {
		t.Fatalf("keepLocal inlined before upload: %#v", input.ReferenceImages[0])
	}
	if err := svc.prepareBeefAPISeedanceReferences(harness.ctx(), "user-1", &input); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(input.ReferenceImages[0].URL, harness.server.URL+"/named/") || input.ReferenceImages[0].DataURL != "" || input.ReferenceImages[0].StorageKey != "" {
		t.Fatalf("local resource not converted: %#v", input.ReferenceImages[0])
	}
	if harness.creates != 1 || harness.createBodies[0].Bytes != int64(len(payload)) {
		t.Fatalf("local upload mismatch: %#v", harness.createBodies)
	}
}

func TestBeefAPISeedanceDirectTaskKeepsInlineWithoutResourceReader(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	input := harness.testInput(
		providerMedia{ID: "img-1", DataURL: dataURL("image/png", []byte("png-bytes")), MimeType: "image/png"},
		providerMedia{},
		providerMedia{},
	)
	_, err := runSeedanceVideosTask(context.Background(), input, fastVideoPollPolicy())
	if harness.creates != 0 {
		t.Fatalf("direct task used preupload create=%d err=%v", harness.creates, err)
	}
	if harness.generates != 1 {
		t.Fatalf("direct task skipped existing inline generate: generates=%d err=%v", harness.generates, err)
	}
}

func TestBeefAPISeedancePutTimeoutHonorsTicketAndContext(t *testing.T) {
	if got := beefAPISeedancePutTimeout(context.Background()); got != beefAPISeedanceUploadTimeout || got == providerHTTPTimeout {
		t.Fatalf("timeout = %s, want 15m dedicated upload window", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if got := beefAPISeedancePutTimeout(ctx); got > 90*time.Second || got <= 0 {
		t.Fatalf("shorter context remaining not honored: %s", got)
	}
	long, stop := context.WithTimeout(context.Background(), 30*time.Minute)
	defer stop()
	if got := beefAPISeedancePutTimeout(long); got != beefAPISeedanceUploadTimeout {
		t.Fatalf("long task deadline = %s, want ticket window not generic 5m", got)
	}
}

func TestBeefAPISeedancePreuploadOpenResourceLargeLocalVideo(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	svc := newResourceTestService(t)
	const size = 70 << 20
	localDir := filepath.Join(svc.dataDir, "resources", "users", "user-1", "video")
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(localDir, "reference.mp4")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(syntheticVideoMP4(1280, 720, 3200)); err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(size); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{
		ID: "beefapi-preupload-large-video", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/video/reference.mp4", MimeType: "video/mp4",
		Size: size, Width: 1280, Height: 720, DurationMs: 3200,
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	input := harness.testInput(
		providerMedia{},
		providerMedia{ID: "vid-1", StorageKey: "resource:beefapi-preupload-large-video", MimeType: "video/mp4"},
		providerMedia{},
	)
	if err := svc.hydrateVideoReferenceMetadata(harness.ctx(), "user-1", &input); err != nil {
		t.Fatal(err)
	}
	if input.ReferenceVideos[0].Width != 1280 || input.ReferenceVideos[0].Height != 720 || input.ReferenceVideos[0].DurationMs != 3200 {
		t.Fatalf("preupload hydrate did not reuse stored metadata: %#v", input.ReferenceVideos[0])
	}
	if err := svc.resolveVideoCapability(harness.ctx(), &input); err != nil {
		t.Fatal(err)
	}
	if err := validateVideoTaskParameters(input.VideoCapability, input); err != nil {
		t.Fatalf("stored metadata blocked parameter preflight: %v", err)
	}
	if err := svc.hydrateGenerationMedia("user-1", &input, providerMediaHydrationPolicyFor(harness.ctx(), input)); err != nil {
		t.Fatal(err)
	}
	if input.ReferenceVideos[0].DataURL != "" || input.ReferenceVideos[0].URL != "" || input.ReferenceVideos[0].StorageKey != "resource:beefapi-preupload-large-video" {
		t.Fatalf("keepLocal lost owned video: %#v", input.ReferenceVideos[0])
	}
	if err := svc.prepareBeefAPISeedanceReferences(harness.ctx(), "user-1", &input); err != nil {
		t.Fatal(err)
	}
	if input.ReferenceVideos[0].Width != 1280 || input.ReferenceVideos[0].Height != 720 || input.ReferenceVideos[0].DurationMs != 3200 {
		t.Fatalf("prepare did not probe the sequential buffer: %#v", input.ReferenceVideos[0])
	}
	if err := validateVideoTask(input.VideoCapability, input); err != nil {
		t.Fatalf("probed local video failed final preflight: %v", err)
	}
	if !strings.HasPrefix(input.ReferenceVideos[0].URL, harness.server.URL+"/named/") || input.ReferenceVideos[0].DataURL != "" || input.ReferenceVideos[0].StorageKey != "" {
		t.Fatalf("OpenResource video not rewritten: %#v", input.ReferenceVideos[0])
	}
	body, err := beefAPIVideoRequestBody(input)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(body)
	if err != nil || len(encoded) > 16<<10 || input.ReferenceVideos[0].Bytes != size || harness.putsByTicket["video"].length != size {
		t.Fatalf("OpenResource 70MiB did not stay URL-only: err=%v json=%d put=%d", err, len(encoded), harness.putsByTicket["video"].length)
	}
}

func TestBeefAPISeedancePreuploadRejectsLocalImageWithMissingStoredGeometry(t *testing.T) {
	harness := newBeefAPISeedanceUploadHarness(t)
	svc := newResourceTestService(t)
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 100, 100))); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(svc.dataDir, "resources", "users", "user-1", "image")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "small.png"), data.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "small-image", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "users/user-1/image/small.png", MimeType: "image/png", Size: int64(data.Len())}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	input := harness.testInput(providerMedia{StorageKey: "resource:small-image"}, providerMedia{}, providerMedia{})
	if err := svc.hydrateVideoReferenceMetadata(harness.ctx(), "user-1", &input); err != nil {
		t.Fatal(err)
	}
	if err := svc.resolveVideoCapability(harness.ctx(), &input); err != nil {
		t.Fatal(err)
	}
	if err := svc.hydrateGenerationMedia("user-1", &input, providerMediaHydrationPolicyFor(harness.ctx(), input)); err != nil {
		t.Fatal(err)
	}
	if input.ReferenceImages[0].Width != 100 || input.ReferenceImages[0].Height != 100 {
		t.Fatal("header geometry was lost")
	}
	err := svc.prepareBeefAPISeedanceReferences(harness.ctx(), "user-1", &input)
	if err == nil || harness.creates != 0 || harness.generates != 0 {
		t.Fatalf("invalid image reached network: err=%v create=%d generate=%d", err, harness.creates, harness.generates)
	}
}

func TestBeefAPISeedancePreuploadRejectsProbedVideoBoundsBeforeUpload(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		width, height, duration int
	}{
		{"pixels", 100, 100, 3200}, {"duration", 1280, 720, 90000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			harness := newBeefAPISeedanceUploadHarness(t)
			svc := newResourceTestService(t)
			input := harness.testInput(providerMedia{}, providerMedia{StorageKey: "resource:video"}, providerMedia{})
			if err := svc.resolveVideoCapability(harness.ctx(), &input); err != nil {
				t.Fatal(err)
			}
			err := prepareBeefAPISeedanceReferences(harness.ctx(), input.Config, &input, func(string, providerMedia) ([]byte, string, bool, error) {
				return syntheticVideoMP4(tc.width, tc.height, int64(tc.duration)), "video/mp4", false, nil
			})
			if err == nil || harness.creates != 0 || harness.puts != 0 {
				t.Fatalf("invalid video uploaded: err=%v create=%d put=%d", err, harness.creates, harness.puts)
			}
		})
	}
}

func TestBeefAPISeedanceJSONLimitStillMatchesArk(t *testing.T) {
	const limit = 64 * 1024 * 1024
	_, _, err := protocolRequestBody(context.Background(), providerConfig{InterfaceType: "volcengine-ark-video"}, protocol.RequestSpec{
		ContentType: "application/json",
		Body:        strings.Repeat("x", limit+1),
	})
	if err == nil || generation.ClassifyError(err).Category != generation.CategoryInputTooLarge {
		t.Fatalf("ark 64MiB bound lost: %v", err)
	}
}

type beefAPISeedancePutRecord struct {
	auth    string
	headers http.Header
	body    []byte
	length  int64
}

type beefAPISeedanceUploadHarness struct {
	server          *httptest.Server
	mu              sync.Mutex
	creates         int
	puts            int
	completes       int
	generates       int
	createStatus    int
	completeStatus  int
	completeBody    []byte
	failCreateAfter int
	redirectPut     bool
	createAuth      string
	completeAuth    string
	createBodies    []beefAPISeedanceUploadRequest
	putsByTicket    map[string]beefAPISeedancePutRecord
	putHook         func(http.ResponseWriter, *http.Request)
	mutateReceipt   func(map[string]interface{})
}

func newBeefAPISeedanceUploadHarness(t *testing.T) *beefAPISeedanceUploadHarness {
	t.Helper()
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	harness := &beefAPISeedanceUploadHarness{putsByTicket: map[string]beefAPISeedancePutRecord{}}
	harness.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/video-references/uploads/complete"):
			harness.mu.Lock()
			harness.completes++
			harness.completeAuth = r.Header.Get("Authorization")
			status := harness.completeStatus
			completeBody := append([]byte(nil), harness.completeBody...)
			harness.mu.Unlock()
			body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
			var req struct {
				Ticket string `json:"ticket"`
			}
			_ = json.Unmarshal(body, &req)
			if status != 0 {
				w.WriteHeader(status)
				if len(completeBody) == 0 {
					completeBody = []byte(`{"error":{"message":"还没有收到文件，请先把文件传完再确认","code":"video_reference_upload_incomplete"}}`)
				}
				_, _ = w.Write(completeBody)
				return
			}
			kind := strings.TrimPrefix(req.Ticket, "ticket-")
			harness.mu.Lock()
			put := harness.putsByTicket[kind]
			harness.mu.Unlock()
			sum := sha256.Sum256(put.body)
			receipt := map[string]interface{}{
				"url":    harness.server.URL + "/named/" + req.Ticket,
				"kind":   kind,
				"mime":   put.headers.Get("Content-Type"),
				"bytes":  len(put.body),
				"sha256": hex.EncodeToString(sum[:]),
			}
			if harness.mutateReceipt != nil {
				harness.mutateReceipt(receipt)
			}
			_ = json.NewEncoder(w).Encode(receipt)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/video-references/uploads"):
			harness.mu.Lock()
			harness.creates++
			harness.createAuth = r.Header.Get("Authorization")
			status := harness.createStatus
			failAfter := harness.failCreateAfter
			creates := harness.creates
			redirectPut := harness.redirectPut
			harness.mu.Unlock()
			body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
			var req beefAPISeedanceUploadRequest
			if err := json.Unmarshal(body, &req); err != nil {
				t.Errorf("create JSON: %v", err)
			}
			harness.mu.Lock()
			harness.createBodies = append(harness.createBodies, req)
			harness.mu.Unlock()
			if status != 0 {
				w.WriteHeader(status)
				return
			}
			if failAfter > 0 && creates > failAfter {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			ticket := "ticket-" + req.Kind
			uploadURL := harness.server.URL + "/objects/" + ticket
			if redirectPut {
				uploadURL = harness.server.URL + "/redirect/" + ticket
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"upload_url":    uploadURL,
				"upload_method": "PUT",
				"required_headers": map[string]string{
					"Content-Type":    req.Mime,
					"x-amz-meta-test": "1",
					"Authorization":   "should-not-be-copied",
				},
				"ticket":            ticket,
				"upload_expires_at": time.Now().Add(15 * time.Minute).Format(time.RFC3339),
				"expires_at":        time.Now().Add(15 * time.Minute).Format(time.RFC3339),
			})
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/redirect/"):
			http.Redirect(w, r, "/objects/"+strings.TrimPrefix(r.URL.Path, "/redirect/"), http.StatusFound)
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/objects/"):
			ticket := strings.TrimPrefix(r.URL.Path, "/objects/")
			body, _ := io.ReadAll(io.LimitReader(r.Body, beefAPISeedanceVideoMaxBytes+1))
			record := beefAPISeedancePutRecord{
				auth:    r.Header.Get("Authorization"),
				headers: r.Header.Clone(),
				body:    append([]byte(nil), body...),
				length:  r.ContentLength,
			}
			harness.mu.Lock()
			harness.puts++
			harness.putsByTicket[strings.TrimPrefix(ticket, "ticket-")] = record
			hook := harness.putHook
			harness.mu.Unlock()
			if hook != nil {
				hook(w, r)
				return
			}
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/videos"):
			harness.mu.Lock()
			harness.generates++
			harness.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "task-should-not-run"})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(harness.server.Close)
	return harness
}

func (h *beefAPISeedanceUploadHarness) ctx() context.Context {
	return generation.WithRuntime(context.Background(), generation.Runtime{
		Endpoints: generation.Endpoints{BeefAPIVideoBaseURL: h.server.URL},
		Probe:     appMediaProbe{},
	})
}

func paddedSyntheticVideo(t *testing.T, size int) []byte {
	t.Helper()
	clip := syntheticVideoMP4(1280, 720, 3200)
	if size < len(clip) {
		size = len(clip)
	}
	data := make([]byte, size)
	copy(data, clip)
	return data
}

func (h *beefAPISeedanceUploadHarness) testInput(image, video, audio providerMedia) canvasGenerationInput {
	input := canvasGenerationInput{
		Mode:   "video",
		Prompt: "make the character walk",
		Config: providerConfig{
			BaseURL:            h.server.URL,
			APIKey:             "secret-key-do-not-leak",
			Model:              "seedance-2.5",
			InterfaceType:      string(model.ChannelInterfaceNewAPIVideo),
			Size:               "16:9",
			VideoSeconds:       "5",
			VQuality:           "720p",
			VideoGenerateAudio: "false",
			VideoWatermark:     "false",
		},
		Metadata: map[string]interface{}{"videoEditOperation": "reference_to_video"},
	}
	if image.ID != "" || image.DataURL != "" || image.URL != "" || image.StorageKey != "" {
		input.ReferenceImages = []providerMedia{image}
	}
	if video.ID != "" || video.DataURL != "" || video.URL != "" || video.StorageKey != "" {
		input.ReferenceVideos = []providerMedia{video}
	}
	if audio.ID != "" || audio.DataURL != "" || audio.URL != "" || audio.StorageKey != "" {
		input.ReferenceAudios = []providerMedia{audio}
	}
	return input
}
