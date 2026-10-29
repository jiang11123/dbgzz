package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
)

// Real uploaded media, Go SQLite ownership, default shipped Durable host and
// intercepted loopback requests. No paid models or production user data.
func TestNativeHistoryRealDefaultHostCanvasScopeAndSDKDeterministicFailure(t *testing.T) {
	testNativeHistoryHost(t, false)
}

func TestNativeHistoryRealDefaultHostRestartsAfterBudgetFailure(t *testing.T) {
	testNativeHistoryHost(t, true)
}

func testNativeHistoryHost(t *testing.T, failAfterMedia bool) {
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	ffmpeg, err := editing.ResolveFFmpegBinary()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	files := map[string]string{"image": filepath.Join(directory, "image.jpg"), "audio": filepath.Join(directory, "audio.wav"), "video": filepath.Join(directory, "video.mp4")}
	picture := image.NewRGBA(image.Rect(0, 0, 512, 320))
	for y := 0; y < 320; y++ {
		for x := 0; x < 512; x++ {
			picture.Set(x, y, color.RGBA{uint8(x), uint8(y), uint8(x + y), 255})
		}
	}
	var encodedImage bytes.Buffer
	if err := jpeg.Encode(&encodedImage, picture, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(files["image"], encodedImage.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	fixtures := [][]string{
		{"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=15", "-c:a", "pcm_s16le", files["audio"]},
		{"-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=15", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=24000:duration=15", "-c:v", "libx264", "-threads", "1", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", files["video"]},
	}
	for _, args := range fixtures {
		command := exec.CommandContext(ctx, ffmpeg, append([]string{"-nostdin", "-v", "error", "-y"}, args...)...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("fixture media: %v %s", err, output)
		}
	}
	attachments := map[string]app.AssistantAttachment{}
	assetIDs := []string{}
	for _, kind := range []string{"image", "audio", "video"} {
		file, err := os.Open(files[kind])
		if err != nil {
			t.Fatal(err)
		}
		stat, err := file.Stat()
		if err != nil {
			file.Close()
			t.Fatal(err)
		}
		width, height, duration := 0, 0, int64(15000)
		if kind == "image" {
			width, height, duration = 512, 320, 0
		}
		if kind == "video" {
			width, height = 640, 360
		}
		resource, err := env.service.UploadResourceFile(owner.ID, filepath.Base(files[kind]), stat.Size(), kind, width, height, duration, file)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		assetID := "native-" + kind
		raw, err := json.Marshal(map[string]any{"id": assetID, "title": kind, "kind": kind, "resourceId": resource.ID, "coverUrl": "", "tags": []string{},
			"data": map[string]any{"storageKey": "resource:" + resource.ID, "width": width, "height": height, "bytes": resource.Size, "mimeType": resource.MimeType}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := env.service.UpsertUserAsset(owner.ID, raw); err != nil {
			t.Fatal(err)
		}
		attachments[kind] = app.AssistantAttachment{ResourceID: resource.ID, AssetID: assetID, Kind: kind, Name: filepath.Base(files[kind]), MimeType: resource.MimeType, Bytes: resource.Size, Purpose: "analysis"}
		assetIDs = append(assetIDs, assetID)
	}
	const turnID = "aabbccddeeff1100"
	env.beginTurn(t, turnID, app.AssistantTurnInput{AssetIDs: assetIDs, PermissionMode: "full-access"})
	const nextTurnID = "aabbccddeeff2200"
	const invalidTurnID = "aabbccddeeff3300"
	env.beginTurn(t, nextTurnID, app.AssistantTurnInput{PermissionMode: "canvas"})
	env.beginTurn(t, invalidTurnID, app.AssistantTurnInput{PermissionMode: "canvas"})
	var invalidated atomic.Bool
	var rejectedPreps atomic.Int64
	env.router.POST("/api/__fixture/invalidate-audio", func(c *gin.Context) {
		err := env.service.Database().Model(&model.Resource{}).Where("id = ?", attachments["audio"].ResourceID).Update("status", "pending").Error
		if err != nil {
			c.String(500, "fixture failed")
			return
		}
		invalidated.Store(true)
		c.JSON(200, map[string]any{"ok": true})
	})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if invalidated.Load() && r.URL.Path == "/api/assistant/runtime/turns/"+turnID+"/bind-session" {
			rejectedPreps.Add(1)
		}
		env.router.ServeHTTP(w, r)
	}))
	defer backend.Close()
	config, err := json.Marshal(map[string]any{"root": root, "directory": directory, "backend": backend.URL + "/api", "canvasId": env.canvasID, "turnId": turnID, "nextTurnId": nextTurnID, "invalidTurnId": invalidTurnID, "hostToken": assistantTestHostToken, "image": attachments["image"], "audio": attachments["audio"], "video": attachments["video"], "failAfterMedia": failAfterMedia})
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(directory, "config.json")
	if err := os.WriteFile(configPath, config, 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, "node", filepath.Join(root, "agent-host/test-support/native-history-go-host-probe.mjs"), configPath)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("actual default Durable native dispatch: %v\n%s", err, output)
	}
	proof, err := os.ReadFile(filepath.Join(directory, "host-result.json"))
	if err != nil {
		t.Fatal(err)
	}
	if rejectedPreps.Load() != 1 {
		t.Fatalf("SDK retried deterministic prepare failure: %d", rejectedPreps.Load())
	}
	t.Logf("Actual request byte hashes: %s", proof)
}
