package app

import (
	"context"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/playback"
)

func mp4Box(typ string, payload []byte) []byte {
	size := 8 + len(payload)
	out := make([]byte, size)
	binary.BigEndian.PutUint32(out[0:4], uint32(size))
	copy(out[4:8], typ)
	copy(out[8:], payload)
	return out
}

func mp4Hdlr(kind string) []byte {
	payload := make([]byte, 21)
	copy(payload[8:12], kind)
	return mp4Box("hdlr", payload)
}

func syntheticTrack(handler string, width, height int, durationMs int64) []byte {
	tkhd := make([]byte, 84)
	binary.BigEndian.PutUint32(tkhd[12:16], 1)
	binary.BigEndian.PutUint32(tkhd[76:80], uint32(width)<<16)
	binary.BigEndian.PutUint32(tkhd[80:84], uint32(height)<<16)
	mdhd := make([]byte, 24)
	binary.BigEndian.PutUint32(mdhd[12:16], 1000)
	binary.BigEndian.PutUint32(mdhd[16:20], uint32(durationMs))
	mdia := append(mp4Hdlr(handler), mp4Box("mdhd", mdhd)...)
	return mp4Box("trak", append(mp4Box("tkhd", tkhd), mp4Box("mdia", mdia)...))
}

func syntheticVideoMP4(width, height int, durationMs int64) []byte {
	ftypPayload := make([]byte, 8)
	copy(ftypPayload[:4], "isom")
	return append(mp4Box("ftyp", ftypPayload), mp4Box("moov", syntheticTrack("vide", width, height, durationMs))...)
}

func stsdBoxWithFourcc(fourcc string) []byte {
	b := make([]byte, 24)
	binary.BigEndian.PutUint32(b[0:4], 24)
	copy(b[4:8], "stsd")
	binary.BigEndian.PutUint32(b[12:16], 1)
	binary.BigEndian.PutUint32(b[16:20], 8)
	copy(b[20:24], fourcc)
	return b
}

func writeAppCodecMP4(t *testing.T, path, fourcc string) {
	t.Helper()
	stsd := stsdBoxWithFourcc(fourcc)
	moov := make([]byte, 8+len(stsd))
	binary.BigEndian.PutUint32(moov[0:4], uint32(len(moov)))
	copy(moov[4:8], "moov")
	copy(moov[8:], stsd)
	ftyp := make([]byte, 16)
	binary.BigEndian.PutUint32(ftyp[0:4], 16)
	copy(ftyp[4:8], "ftyp")
	copy(ftyp[8:12], "isom")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(append([]byte{}, ftyp...), moov...), 0o644); err != nil {
		t.Fatal(err)
	}
}

func loadQAGrokImagineVideo(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "qa-grok-imagine-720square.mp4"))
	if err != nil || len(data) == 0 {
		t.Fatalf("QA Grok Imagine MP4 fixture is missing: %v", err)
	}
	return data
}

func TestProbeGeneratedVideoMediaReadsQAGrokImagineFile(t *testing.T) {
	data := loadQAGrokImagineVideo(t)
	width, height, durationMs := probeGeneratedVideoMedia(data)
	if width != 720 || height != 720 {
		t.Fatalf("QA clip dimensions = %dx%d, want 720x720", width, height)
	}
	if durationMs < 6041 || durationMs > 6042 {
		t.Fatalf("QA clip durationMs = %d, want 6041–6042 (6.041667s)", durationMs)
	}
}

func TestStartupDoesNotPrepareLegacyVideos(t *testing.T) {
	service, db := newProjectAssetLinkTestService(t)
	dataDir := t.TempDir()
	service.dataDir = dataDir

	seedLegacy := func(id, fourcc string) {
		t.Helper()
		rel := filepath.Join("clips", id+".mp4")
		writeAppCodecMP4(t, filepath.Join(dataDir, "resources", filepath.FromSlash(rel)), fourcc)
		res := model.Resource{
			ID: id, UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
			Provider: "local", ObjectKey: rel, PlaybackStatus: model.PlaybackStatusNone,
		}
		if err := db.Create(&res).Error; err != nil {
			t.Fatal(err)
		}
	}
	seedLegacy("legacy-h264", "avc1")
	seedLegacy("legacy-mpeg4", "mp4v")

	service.RecoverPlaybackTranscodes()

	var h264 model.Resource
	if err := db.First(&h264, "id = ?", "legacy-h264").Error; err != nil {
		t.Fatal(err)
	}
	if h264.PlaybackStatus != model.PlaybackStatusNone {
		t.Fatalf("H.264 存量 none 行被错误改判为 %q", h264.PlaybackStatus)
	}

	var mp4v model.Resource
	if err := db.First(&mp4v, "id = ?", "legacy-mpeg4").Error; err != nil {
		t.Fatal(err)
	}
	if mp4v.PlaybackStatus == model.PlaybackStatusProcessing {
		t.Fatal("runner 拒绝后 claim 仍停在 processing，重启无法恢复")
	}
	if mp4v.PlaybackStatus == model.PlaybackStatusReady {
		t.Fatal("无 runtime worker 时不应写出 READY")
	}
}

func TestOpenResourcePlaybackRangeUsesPlaybackDomain(t *testing.T) {
	service, db := newProjectAssetLinkTestService(t)
	dataDir := t.TempDir()
	service.dataDir = dataDir
	payload := []byte("app-playback-range")
	path := filepath.Join(dataDir, playback.DirName, "range-1.mp4")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, payload, 0o644); err != nil {
		t.Fatal(err)
	}
	res := model.Resource{
		ID: "range-1", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", PlaybackStatus: model.PlaybackStatusReady, PlaybackObjectKey: "range-1.mp4",
	}
	if err := db.Create(&res).Error; err != nil {
		t.Fatal(err)
	}
	stream, err := service.OpenResourcePlaybackRange("user-1", "range-1")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	got, err := io.ReadAll(stream.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("body = %q", got)
	}
}

func TestMediaDomainsAreRuntimeOwned(t *testing.T) {
	service, _ := newProjectAssetLinkTestService(t)
	if service.playbackRuntime() != service.playbackRuntime() {
		t.Fatal("playback instance replaced")
	}
	if service.depthCaptureRuntime() != service.depthCaptureRuntime() {
		t.Fatal("depth instance replaced")
	}
}

func TestRecoverResetsStuckProcessingThroughService(t *testing.T) {
	service, db := newProjectAssetLinkTestService(t)
	service.backgroundWorkers().Start()
	t.Cleanup(func() { _ = service.StopWorker(context.Background()) })
	dataDir := t.TempDir()
	service.dataDir = dataDir
	rel := filepath.Join("clips", "stuck.mp4")
	writeAppCodecMP4(t, filepath.Join(dataDir, "resources", filepath.FromSlash(rel)), "avc1")
	res := model.Resource{
		ID: "stuck-claim", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: rel, PlaybackStatus: model.PlaybackStatusProcessing,
		PlaybackError: "interrupted",
	}
	if err := db.Create(&res).Error; err != nil {
		t.Fatal(err)
	}
	service.RecoverPlaybackTranscodes()
	var got model.Resource
	if err := db.First(&got, "id = ?", "stuck-claim").Error; err != nil {
		t.Fatal(err)
	}
	if got.PlaybackStatus != "" {
		t.Fatalf("stuck claim after recovery = %q, want pending until playback requested", got.PlaybackStatus)
	}
}
