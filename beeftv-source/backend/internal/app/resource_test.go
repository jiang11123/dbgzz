package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/iotest"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestNormalizeSingleByteRange(t *testing.T) {
	tests := map[string]string{
		"bytes=0-1023":       "bytes=0-1023",
		"bytes=1024-":        "bytes=1024-",
		"bytes=-2048":        "bytes=-2048",
		"bytes=0-1,10-20":    "",
		"items=0-10":         "",
		"bytes=invalid-1024": "",
	}
	for input, expected := range tests {
		if actual := normalizeSingleByteRange(input); actual != expected {
			t.Fatalf("normalizeSingleByteRange(%q) = %q, want %q", input, actual, expected)
		}
	}
}

func TestVideoReferenceMetadataPreflightUsesOwnedResource(t *testing.T) {
	svc := newResourceTestService(t)
	resource := model.Resource{ID: "voice-preflight", UserID: "user-1", Kind: "audio", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "not-downloaded.mp3", MimeType: "audio/mpeg", DurationMs: 2500, Size: 1200}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	input := canvasGenerationInput{Prompt: "test", Config: providerConfig{InterfaceType: "newapi-channel-2", Model: "seedance-2.5", VideoSeconds: "5"}, ReferenceAudios: []providerMedia{{StorageKey: "resource:voice-preflight"}}}
	if err := svc.hydrateVideoReferenceMetadata(context.Background(), "user-1", &input); err != nil {
		t.Fatal(err)
	}
	if input.ReferenceAudios[0].DurationMs != 2500 || input.ReferenceAudios[0].Bytes != 1200 {
		t.Fatalf("resource metadata lost: %#v", input.ReferenceAudios[0])
	}
	if err := svc.validateResolvedVideoCapability(&input); err != nil {
		t.Fatalf("valid stored voice rejected: %v", err)
	}
	if err := svc.hydrateVideoReferenceMetadata(context.Background(), "another-user", &input); err == nil {
		t.Fatal("foreign resource accepted")
	}
}

func TestLocalHydrateRequiredURLRejectsLoopbackResourceURL(t *testing.T) {
	svc := newResourceTestService(t)
	svc.mode = serviceModeLocal
	svc.localResourceStorage = true
	resource := model.Resource{ID: "resource-local-url-only", UserID: "user-1", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "users/user-1/image/reference.png", MimeType: "image/png"}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	err := svc.hydrateProviderMedia("user-1", &providerMedia{StorageKey: "resource:resource-local-url-only"}, providerMediaHydrationPolicy{RequireURL: true})
	if err == nil || !strings.Contains(err.Error(), "支持内嵌素材") || strings.Contains(err.Error(), "127.0.0.1") {
		t.Fatalf("local URL-only media error = %v, want a clear local capability error", err)
	}
}

func TestLocalHydrateRejectsLegacyRemoteResourceMetadata(t *testing.T) {
	svc := newResourceTestService(t)
	svc.mode = serviceModeLocal
	svc.localResourceStorage = true
	resource := model.Resource{
		ID: "resource-legacy-oss", UserID: "user-1", Status: model.ResourceStatusReady,
		Provider: "aliyun", ObjectKey: "users/user-1/image/legacy.png", MimeType: "image/png",
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	err := svc.hydrateProviderMedia("user-1", &providerMedia{StorageKey: "resource:resource-legacy-oss"}, providerMediaHydrationPolicy{PreferURL: true})
	if err == nil || !strings.Contains(err.Error(), "本地工作区") || strings.Contains(err.Error(), "对象存储") {
		t.Fatalf("legacy remote resource error = %v, want local-only guidance", err)
	}
}

func TestBeefAPIPrefersHTTPSResourceURLWhenPublicBaseConfigured(t *testing.T) {
	svc := newResourceTestService(t)
	t.Setenv("CANVAS_PUBLIC_BASE_URL", "https://example.com")
	localDir := filepath.Join(svc.dataDir, "resources", "users", "user-1", "audio")
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(localDir, "voice.mp3"), []byte("mp3-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{
		ID: "beefapi-https-audio", UserID: "user-1", Kind: "audio", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/audio/voice.mp3", MimeType: "audio/mpeg", Size: 9, DurationMs: 3000,
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	input := canvasGenerationInput{
		Mode:   "video",
		Prompt: "follow the soundtrack",
		Config: providerConfig{
			BaseURL: "https://enterprise.beefapi.com", InterfaceType: string(model.ChannelInterfaceNewAPIVideo), Model: "seedance-2.5",
		},
		ReferenceAudios: []providerMedia{{ID: "audio-1", StorageKey: "resource:beefapi-https-audio", URL: "https://example.com/stale-reference.mp3", DataURL: "data:audio/mpeg;base64,c3RhbGU=", MimeType: "audio/mpeg", DurationMs: 3000}},
		Metadata:        map[string]interface{}{"videoEditOperation": "audio_to_video"},
	}
	if err := svc.hydrateGenerationMedia("user-1", &input, providerMediaHydrationPolicyFor(context.Background(), input)); err != nil {
		t.Fatalf("hydrateGenerationMedia() error = %v", err)
	}
	if input.ReferenceAudios[0].StorageKey != "resource:beefapi-https-audio" || input.ReferenceAudios[0].URL != "" || strings.HasPrefix(input.ReferenceAudios[0].DataURL, "data:") {
		t.Fatalf("audio = %#v, want owned local key until preupload", input.ReferenceAudios[0])
	}
	if input.ReferenceAudios[0].MimeType != "audio/mpeg" || input.ReferenceAudios[0].Bytes != 9 || input.ReferenceAudios[0].DurationMs != 3000 {
		t.Fatalf("keepLocal metadata lost: %#v", input.ReferenceAudios[0])
	}
}

func TestBeefAPILocalAudioWithoutPublicHTTPSUsesDataURL(t *testing.T) {
	svc := newResourceTestService(t)
	localDir := filepath.Join(svc.dataDir, "resources", "users", "user-1", "audio")
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(localDir, "voice.mp3"), []byte("mp3-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{
		ID: "beefapi-local-audio", UserID: "user-1", Kind: "audio", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/audio/voice.mp3", MimeType: "audio/mpeg", Size: 9, DurationMs: 3000,
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	media := &providerMedia{StorageKey: "resource:beefapi-local-audio", MimeType: "audio/mpeg"}
	if err := svc.hydrateProviderMedia("user-1", media, providerMediaHydrationPolicy{PreferHTTPS: true}); err != nil {
		t.Fatalf("local audio hydrate error = %v", err)
	}
	if !strings.HasPrefix(media.DataURL, "data:audio/mpeg;base64,") {
		t.Fatalf("local audio = %#v, want data URL", media)
	}
}

func TestMissingImageMetadataHydratesHeaderAndRejectsTooSmallBeforeProvider(t *testing.T) {
	svc := newResourceTestService(t)
	localDir := filepath.Join(svc.dataDir, "resources", "users", "user-1", "image")
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		t.Fatal(err)
	}
	small := encodeTestPNG(t, 384, 216)
	large := encodeTestPNG(t, 800, 800)
	if err := os.WriteFile(filepath.Join(localDir, "small.png"), small, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(localDir, "large.png"), large, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, resource := range []model.Resource{
		{ID: "small-image", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "users/user-1/image/small.png", MimeType: "image/png", Size: int64(len(small))},
		{ID: "large-image", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "users/user-1/image/large.png", MimeType: "image/png", Size: int64(len(large))},
	} {
		if err := svc.repo.CreateResource(&resource); err != nil {
			t.Fatal(err)
		}
	}
	input := canvasGenerationInput{
		Prompt: "test",
		Config: providerConfig{InterfaceType: "newapi-channel-2", Model: "seedance-2.5", VideoSeconds: "5", Size: "16:9", VQuality: "720p"},
		ReferenceImages: []providerMedia{
			{StorageKey: "resource:small-image", MimeType: "image/png"},
			{StorageKey: "resource:large-image", MimeType: "image/png"},
		},
	}
	if err := svc.hydrateVideoReferenceMetadata(context.Background(), "user-1", &input); err != nil {
		t.Fatal(err)
	}
	if input.ReferenceImages[0].Width != 384 || input.ReferenceImages[0].Height != 216 {
		t.Fatalf("small image metadata = %#v", input.ReferenceImages[0])
	}
	if input.ReferenceImages[1].Width != 800 || input.ReferenceImages[1].Height != 800 {
		t.Fatalf("large image metadata = %#v", input.ReferenceImages[1])
	}
	err := svc.validateResolvedVideoCapability(&input)
	if err == nil || !strings.Contains(err.Error(), "216") || !strings.Contains(err.Error(), "调整尺寸或更换") {
		t.Fatalf("missing-metadata 384x216 error = %v", err)
	}
}

func encodeTestPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, width, height))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestBeefAPILocalVideoReferenceHydratesInlineForFlatRequest(t *testing.T) {
	svc := newResourceTestService(t)
	localDir := filepath.Join(svc.dataDir, "resources", "users", "user-1", "image")
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(localDir, "reference.png"), []byte("png-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{
		ID: "beefapi-local-reference", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/reference.png", MimeType: "image/png",
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	input := canvasGenerationInput{
		Mode:   "video",
		Prompt: "make the character walk",
		Config: providerConfig{
			BaseURL: "https://enterprise.beefapi.com", InterfaceType: string(model.ChannelInterfaceNewAPIVideo), Model: "seedance-2.5",
		},
		ReferenceImages: []providerMedia{{ID: "image-1", StorageKey: "resource:beefapi-local-reference", MimeType: "image/png"}},
		Metadata:        map[string]interface{}{"videoEditOperation": "image_to_video"},
	}
	if err := svc.hydrateGenerationMedia("user-1", &input, providerMediaHydrationPolicyFor(context.Background(), input)); err != nil {
		t.Fatalf("hydrateGenerationMedia() error = %v", err)
	}
	if input.ReferenceImages[0].DataURL != "" || input.ReferenceImages[0].StorageKey != "resource:beefapi-local-reference" {
		t.Fatalf("keepLocal inlined local Seedance media: %#v", input.ReferenceImages[0])
	}
	if input.ReferenceImages[0].MimeType != "image/png" {
		t.Fatalf("resource mime lost: %#v", input.ReferenceImages[0])
	}
	input.ReferenceImages[0].URL = "https://example.com/reference.png"
	body, err := beefAPIVideoRequestBody(input)
	if err != nil {
		t.Fatal(err)
	}
	content := body["content"].([]map[string]interface{})
	image, _ := content[0]["image_url"].(map[string]interface{})
	if fmt.Sprint(image["url"]) != "https://example.com/reference.png" {
		t.Fatalf("image = %#v, want URL-only reference", image)
	}
	if content[0]["role"] != "first_frame" || body["metadata"].(map[string]interface{})["ratio"] != "adaptive" {
		t.Fatal("hydration lost frame constraints")
	}
}

func newResourceTestService(t *testing.T) *Service {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{}, &model.Resource{}); err != nil {
		t.Fatal(err)
	}
	svc := &Service{repo: repository.New(db), dataDir: t.TempDir()}
	_ = svc.resourceDomain()
	return svc
}

func TestResourceDomainMemoizesConcurrentFirstCallers(t *testing.T) {
	svc := newResourceTestService(t)
	const workers = 32
	got := make([]any, workers)
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func(index int) {
			defer wg.Done()
			got[index] = svc.resourceDomain()
		}(i)
	}
	wg.Wait()
	first := svc.resourceDomain()
	if first == nil {
		t.Fatal("resourceDomain returned nil")
	}
	for index, value := range got {
		if value != first {
			t.Fatalf("caller %d got a different asset.Service", index)
		}
	}
}

func TestNewServiceResourceDomainKeepsWiredPointer(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	svc := newService(repository.New(db), t.TempDir(), serviceOptions{mode: serviceModeLocal})
	if svc.assets == nil {
		t.Fatal("newService did not wire assets")
	}
	if svc.resourceDomain() != svc.assets {
		t.Fatal("resourceDomain diverged from constructor pointer")
	}
}

func TestStoreResourceReusesReadyUploadIdentity(t *testing.T) {
	svc := newResourceTestService(t)
	uploadKey := normalizedResourceUploadKey([]string{"image:user-1:logical-upload"})
	first, stored, err := svc.storeResource("user-1", "image", "first.png", "image/png", 7, 1, 1, 0, bytes.NewReader([]byte("payload")), uploadKey, false)
	if err != nil {
		t.Fatal(err)
	}
	if !stored {
		t.Fatal("first upload was not stored")
	}
	second, stored, err := svc.storeResource("user-1", "image", "second.png", "image/png", 7, 1, 1, 0, bytes.NewReader([]byte("payload")), uploadKey, false)
	if err != nil {
		t.Fatal(err)
	}
	if stored || second.ID != first.ID || second.ObjectKey != first.ObjectKey {
		t.Fatalf("idempotent upload = %#v, stored=%v; first=%#v", second, stored, first)
	}
	resources, err := svc.repo.Resources("user-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(resources) != 1 {
		t.Fatalf("resource count = %d, want 1", len(resources))
	}
}

func TestRetryStoredResourceKeepsOriginalObjectKey(t *testing.T) {
	svc := newResourceTestService(t)
	uploadKey := normalizedResourceUploadKey([]string{"image:user-1:retry-upload"})
	failed := &model.Resource{
		ID: "resource-failed", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/fixed.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := svc.repo.CreateResource(failed); err != nil {
		t.Fatal(err)
	}
	retried, err := svc.retryStoredResource("user-1", failed, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if err != nil {
		t.Fatal(err)
	}
	if retried.ID != failed.ID || retried.ObjectKey != "users/user-1/image/fixed.png" || retried.Status != model.ResourceStatusReady {
		t.Fatalf("retried resource = %#v", retried)
	}
	resources, err := svc.repo.Resources("user-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(resources) != 1 {
		t.Fatalf("resource count = %d, want 1", len(resources))
	}
	day := time.Now().UTC().Format("2006-01-02")
	usage, err := svc.repo.DailyUploadBytes("user-1", day)
	if err != nil {
		t.Fatal(err)
	}
	if usage != 7 {
		t.Fatalf("daily upload usage = %d, want 7", usage)
	}
}

func TestRetryStoredResourceReleasesDailyQuotaAfterFailure(t *testing.T) {
	svc := newResourceTestService(t)
	uploadKey := normalizedResourceUploadKey([]string{"image:user-1:failed-retry"})
	failed := &model.Resource{
		ID: "resource-failed-retry", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/failed.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := svc.repo.CreateResource(failed); err != nil {
		t.Fatal(err)
	}
	_, err := svc.retryStoredResource("user-1", failed, "image", "image/png", 7, iotest.ErrReader(errors.New("write failed")))
	if err == nil || !strings.Contains(err.Error(), "write failed") {
		t.Fatalf("retryStoredResource() error = %v", err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	usage, usageErr := svc.repo.DailyUploadBytes("user-1", day)
	if usageErr != nil {
		t.Fatal(usageErr)
	}
	if usage != 0 {
		t.Fatalf("daily upload usage = %d, want 0", usage)
	}
}

func TestLegacyMediaMigrationSkipsInvalidDataURL(t *testing.T) {
	svc := &Service{}
	input := map[string]interface{}{
		"history": []interface{}{
			map[string]interface{}{"content": "data:video/mp4;base64,broken"},
		},
	}

	result, err := svc.persistLegacyGeneratedMediaResult("user-1", input)
	if err != nil {
		t.Fatalf("persistLegacyGeneratedMediaResult() error = %v", err)
	}
	history := result["history"].([]interface{})
	content := history[0].(map[string]interface{})["content"]
	if content != "data:video/mp4;base64,broken" {
		t.Fatalf("invalid legacy content changed to %v", content)
	}
}

func TestLocalProviderMediaUsesReachableReferenceGuidance(t *testing.T) {
	svc := &Service{mode: serviceModeLocal, localResourceStorage: true}
	for _, media := range []providerMedia{{DataURL: "data:video/mp4;base64,AAAA"}, {URL: "data:video/mp4;base64,AAAA"}} {
		err := svc.hydrateProviderMedia("user-1", &media, providerMediaHydrationPolicy{RequireURL: true})
		if err == nil || !strings.Contains(err.Error(), "HTTPS") || strings.Contains(err.Error(), "本地资源目录") {
			t.Fatalf("local inline reference error = %v", err)
		}
	}
}

func TestGeneratedMediaRejectsInvalidDataURL(t *testing.T) {
	svc := &Service{}
	_, err := svc.persistGeneratedMediaResult("user-1", map[string]interface{}{
		"content": "data:video/mp4;base64,broken",
	})
	if err == nil {
		t.Fatal("persistGeneratedMediaResult() error = nil, want invalid data URL error")
	}
}

func TestPersistGeneratedMediaAppliesStoredFileQuota(t *testing.T) {
	svc := newResourceTestService(t)
	if err := svc.repo.Create(&model.Resource{
		ID:     "existing",
		UserID: "user-1",
		Status: model.ResourceStatusReady,
		Size:   gigabytes(defaultRuntimePolicy().Resource.StoredFileGB) - 1,
	}); err != nil {
		t.Fatal(err)
	}

	_, err := svc.persistGeneratedMediaResult("user-1", map[string]interface{}{
		"image": map[string]interface{}{"dataUrl": "data:image/png;base64,YQ=="},
	})
	if err == nil || !strings.Contains(err.Error(), "20GB 上限") {
		t.Fatalf("persistGeneratedMediaResult() error = %v", err)
	}
}

func TestLocalGeneratedMediaIsPersistedAsLocalResource(t *testing.T) {
	svc := newResourceTestService(t)
	svc.localResourceStorage = true
	result, err := svc.persistGeneratedMediaResult("user-1", map[string]interface{}{
		"image": map[string]interface{}{"dataUrl": "data:image/png;base64,YQ=="},
	})
	if err != nil {
		t.Fatal(err)
	}
	imageValue, ok := result["image"].(map[string]interface{})
	if !ok || !strings.HasPrefix(stringField(imageValue, "storageKey"), "resource:") {
		t.Fatalf("stored image = %#v", result["image"])
	}
	resourceID := strings.TrimPrefix(stringField(imageValue, "storageKey"), "resource:")
	resource, err := svc.repo.ResourceForUser("user-1", resourceID)
	if err != nil {
		t.Fatal(err)
	}
	if resource.Provider != "local" || resource.Status != model.ResourceStatusReady {
		t.Fatalf("generated resource = %#v, want ready local resource", resource)
	}
	if _, err := os.Stat(filepath.Join(svc.dataDir, "resources", filepath.FromSlash(resource.ObjectKey))); err != nil {
		t.Fatalf("local generated file missing: %v", err)
	}
}

func TestPersistGeneratedVideoRepairsMissingDimensionsAndDuration(t *testing.T) {
	svc := newResourceTestService(t)
	svc.localResourceStorage = true
	clip := syntheticVideoMP4(1280, 720, 5042)
	result, err := svc.persistGeneratedMediaResult("user-1", map[string]interface{}{
		"mode": "video",
		"video": map[string]interface{}{
			"dataUrl":  "data:video/mp4;base64," + base64.StdEncoding.EncodeToString(clip),
			"mimeType": "video/mp4",
			"width":    0,
			"height":   0,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	video, ok := result["video"].(map[string]interface{})
	if !ok {
		t.Fatalf("video = %#v", result["video"])
	}
	if intValue(video["width"]) != 1280 || intValue(video["height"]) != 720 {
		t.Fatalf("result dimensions = %#v", video)
	}
	if int64(intValue(video["durationMs"])) != 5042 {
		t.Fatalf("result durationMs = %#v, want 5042", video["durationMs"])
	}
	resourceID := strings.TrimPrefix(stringField(video, "storageKey"), "resource:")
	resource, err := svc.repo.ResourceForUser("user-1", resourceID)
	if err != nil {
		t.Fatal(err)
	}
	if resource.Width != 1280 || resource.Height != 720 || resource.DurationMs != 5042 {
		t.Fatalf("resource media = %#v", resource)
	}
}

func TestResourceFileExtensionMapsWaveMIMEAliasesToWav(t *testing.T) {
	for _, mimeType := range []string{"audio/wave", "audio/wav", "audio/x-wav", "audio/vnd.wave"} {
		if got := resourceFileExtension("", mimeType, "audio"); got != ".wav" {
			t.Fatalf("resourceFileExtension(%q) = %q, want .wav", mimeType, got)
		}
	}
}
