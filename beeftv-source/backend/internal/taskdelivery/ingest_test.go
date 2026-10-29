package taskdelivery

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/playback"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

const tinyPNGDataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

func TestIngestIdentityDoesNotAliasJSONKeys(t *testing.T) {
	ingestor, _, repo, _, _ := newIngestHarness(t, ingestNopQuota{})
	image := func() map[string]interface{} { return map[string]interface{}{"dataUrl": tinyPNGDataURL} }
	input := map[string]interface{}{
		"a/b": image(), "a": map[string]interface{}{"b": image()},
		" b ": image(), "b": image(), "": image(),
	}
	first, err := ingestor.IngestResult("user-1", input, IngestOptions{EnforceQuota: true, IdentityPrefix: "task-key-test"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = ingestor.IngestResult("user-1", input, IngestOptions{EnforceQuota: true, IdentityPrefix: "task-key-test"})
	if err != nil {
		t.Fatal(err)
	}
	resources, err := repo.Resources("user-1", 20)
	if err != nil || len(resources) != 5 {
		t.Fatalf("resources=%d err=%v", len(resources), err)
	}
	if stringField(nestedMap(t, first, "a/b"), "resourceId") == stringField(nestedMap(t, first, "a", "b"), "resourceId") {
		t.Fatal("literal slash key aliased a nested resource")
	}
}

func TestIngestNestedImageVideoAudioResult(t *testing.T) {
	ingestor, assets, repo, _, dataDir := newIngestHarness(t, ingestNopQuota{})
	clip := syntheticVideoMP4(1280, 720, 5042)
	audio := []byte("audio-bytes")
	result, err := ingestor.IngestResult("user-1", map[string]interface{}{
		"mode": "mixed",
		"images": []interface{}{
			map[string]interface{}{"dataUrl": tinyPNGDataURL, "url": "blob:preview"},
		},
		"video": map[string]interface{}{
			"dataUrl":  dataURL("video/mp4", clip),
			"mimeType": "video/mp4",
			"width":    0,
			"height":   0,
		},
		"audio": map[string]interface{}{
			"content": dataURL("audio/mpeg", audio),
		},
		"extra": map[string]interface{}{
			"coverUrl": tinyPNGDataURL,
		},
	}, IngestOptions{EnforceQuota: true})
	if err != nil {
		t.Fatal(err)
	}
	imageItem := nestedMap(t, result, "images", 0)
	videoItem := nestedMap(t, result, "video")
	audioItem := nestedMap(t, result, "audio")
	coverItem := nestedMap(t, result, "extra")
	if imageItem["url"] != imageItem["dataUrl"] || !strings.HasPrefix(stringField(imageItem, "storageKey"), "resource:") {
		t.Fatalf("image rewrite = %#v", imageItem)
	}
	if intValue(videoItem["width"]) != 1280 || intValue(videoItem["height"]) != 720 || int64(intValue(videoItem["durationMs"])) != 5042 {
		t.Fatalf("video probe = %#v", videoItem)
	}
	if stringField(audioItem, "content") == dataURL("audio/mpeg", audio) {
		t.Fatal("audio content still inline")
	}
	if !strings.HasPrefix(stringField(coverItem, "coverUrl"), "/api/resources/") {
		t.Fatalf("cover rewrite = %#v", coverItem)
	}
	ids := uniqueResourceIDs(imageItem, videoItem, audioItem, coverItem)
	if len(ids) != 4 {
		t.Fatalf("resource ids = %v, want 4 isolated inlines", ids)
	}
	for _, id := range ids {
		resource, err := assets.Resource("user-1", id)
		if err != nil || resource.Status != model.ResourceStatusReady || resource.Provider != "local" {
			t.Fatalf("resource %s = %#v err=%v", id, resource, err)
		}
		if _, err := os.Stat(filepath.Join(dataDir, "resources", filepath.FromSlash(resource.ObjectKey))); err != nil {
			t.Fatalf("bytes missing for %s: %v", id, err)
		}
	}
	listed, err := repo.Resources("user-1", 20)
	if err != nil || len(listed) != 4 {
		t.Fatalf("listed = %d err=%v", len(listed), err)
	}
}

func TestIngestMalformedDataURLStrictVersusLegacy(t *testing.T) {
	ingestor, _, repo, _, _ := newIngestHarness(t, ingestNopQuota{})
	broken := map[string]interface{}{
		"history": []interface{}{
			map[string]interface{}{"content": "data:video/mp4;base64,broken"},
		},
	}
	if _, err := ingestor.IngestResult("user-1", broken, IngestOptions{EnforceQuota: true}); err == nil || !errors.Is(err, ErrInvalidGeneratedDataURL) {
		t.Fatalf("strict err = %v", err)
	}
	legacy, err := ingestor.IngestResult("user-1", broken, IngestOptions{SkipInvalidDataURL: true, EnforceQuota: false})
	if err != nil {
		t.Fatal(err)
	}
	history := legacy["history"].([]interface{})
	content := history[0].(map[string]interface{})["content"]
	if content != "data:video/mp4;base64,broken" {
		t.Fatalf("legacy rewritten = %#v", content)
	}
	listed, err := repo.Resources("user-1", 10)
	if err != nil || len(listed) != 0 {
		t.Fatalf("legacy skip stored %d resources err=%v", len(listed), err)
	}

	mixed, err := ingestor.IngestResult("user-1", map[string]interface{}{
		"items": []interface{}{
			map[string]interface{}{"dataUrl": tinyPNGDataURL},
			map[string]interface{}{"dataUrl": "data:video/mp4;base64,broken"},
		},
	}, IngestOptions{SkipInvalidDataURL: true, EnforceQuota: false})
	if err != nil {
		t.Fatal(err)
	}
	items := mixed["items"].([]interface{})
	valid := items[0].(map[string]interface{})
	invalid := items[1].(map[string]interface{})
	if !strings.HasPrefix(stringField(valid, "storageKey"), "resource:") {
		t.Fatalf("legacy valid not stored: %#v", valid)
	}
	if invalid["dataUrl"] != "data:video/mp4;base64,broken" {
		t.Fatalf("legacy invalid changed: %#v", invalid)
	}
}

func TestIngestQuotaRefusalDoesNotRewrite(t *testing.T) {
	ingestor, _, repo, _, _ := newIngestHarness(t, ingestRefuseQuota{err: errors.New("账号资源和会话附件已达到 20GB 上限")})
	_, err := ingestor.IngestResult("user-1", map[string]interface{}{
		"image": map[string]interface{}{"dataUrl": tinyPNGDataURL},
	}, IngestOptions{EnforceQuota: true})
	if err == nil || !strings.Contains(err.Error(), "20GB 上限") {
		t.Fatalf("quota err = %v", err)
	}
	listed, listErr := repo.Resources("user-1", 10)
	if listErr != nil || len(listed) != 0 {
		t.Fatalf("quota refusal stored %d err=%v", len(listed), listErr)
	}
}

func TestIngestLegacySkipDoesNotReserveGeneratedQuota(t *testing.T) {
	ingestor, _, repo, _, _ := newIngestHarness(t, ingestRefuseQuota{err: errors.New("20GB 上限")})
	result, err := ingestor.IngestResult("user-1", map[string]interface{}{
		"image": map[string]interface{}{"dataUrl": tinyPNGDataURL},
	}, IngestOptions{SkipInvalidDataURL: true, EnforceQuota: false})
	if err != nil {
		t.Fatal(err)
	}
	imageItem := nestedMap(t, result, "image")
	if !strings.HasPrefix(stringField(imageItem, "storageKey"), "resource:") {
		t.Fatalf("legacy store = %#v", imageItem)
	}
	listed, err := repo.Resources("user-1", 10)
	if err != nil || len(listed) != 1 {
		t.Fatalf("legacy resources = %d err=%v", len(listed), err)
	}
}

func TestIngestSameIdentityRecoversAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "meta.db")
	first, assets, _, db, _ := openIngestHarness(t, dbPath, dir, ingestNopQuota{})
	opts := IngestOptions{EnforceQuota: true, IdentityPrefix: "task-restore"}
	input := map[string]interface{}{"image": map[string]interface{}{"dataUrl": tinyPNGDataURL}}
	firstResult, err := first.IngestResult("user-1", input, opts)
	if err != nil {
		t.Fatal(err)
	}
	firstID := stringField(nestedMap(t, firstResult, "image"), "resourceId")
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}

	restarted, restartedAssets, repo, db, dataDir := openIngestHarness(t, dbPath, dir, ingestNopQuota{})
	defer closeSQL(t, db)
	second, err := restarted.IngestResult("user-1", input, opts)
	if err != nil {
		t.Fatal(err)
	}
	secondID := stringField(nestedMap(t, second, "image"), "resourceId")
	if firstID == "" || firstID != secondID {
		t.Fatalf("identity restart %q vs %q", firstID, secondID)
	}
	listed, err := repo.Resources("user-1", 10)
	if err != nil || len(listed) != 1 || listed[0].ID != firstID || listed[0].Status != model.ResourceStatusReady {
		t.Fatalf("restart resources = %#v err=%v", listed, err)
	}
	resource, err := restartedAssets.Resource("user-1", firstID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "resources", filepath.FromSlash(resource.ObjectKey))); err != nil {
		t.Fatalf("restart bytes missing: %v", err)
	}
	_ = assets
}

func TestIngestExistingResourceReuse(t *testing.T) {
	ingestor, _, repo, _, _ := newIngestHarness(t, ingestNopQuota{})
	opts := IngestOptions{EnforceQuota: true, IdentityPrefix: "task-reuse"}
	first, err := ingestor.IngestResult("user-1", map[string]interface{}{
		"image": map[string]interface{}{"dataUrl": tinyPNGDataURL},
	}, opts)
	if err != nil {
		t.Fatal(err)
	}
	rewritten, err := ingestor.IngestResult("user-1", first, opts)
	if err != nil {
		t.Fatal(err)
	}
	firstID := stringField(nestedMap(t, first, "image"), "resourceId")
	secondID := stringField(nestedMap(t, rewritten, "image"), "resourceId")
	if firstID == "" || firstID != secondID {
		t.Fatalf("rewritten reuse %q vs %q", firstID, secondID)
	}
	replay, err := ingestor.IngestResult("user-1", map[string]interface{}{
		"image": map[string]interface{}{"dataUrl": tinyPNGDataURL},
	}, opts)
	if err != nil {
		t.Fatal(err)
	}
	if stringField(nestedMap(t, replay, "image"), "resourceId") != firstID {
		t.Fatalf("same-identity replay = %#v", replay)
	}
	listed, err := repo.Resources("user-1", 10)
	if err != nil || len(listed) != 1 {
		t.Fatalf("reuse created extra rows: %#v err=%v", listed, err)
	}
}

func TestIngestFailureDoesNotBindOrComplete(t *testing.T) {
	ingestor, _, repo, db, _ := newIngestHarness(t, ingestNopQuota{})
	now := model.Task{ID: "task-running", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusRunning, Prompt: "x"}
	if err := db.AutoMigrate(&model.Task{}, &model.Result{}, &model.Asset{}, &model.AssetVersion{}, &model.AssetRepresentation{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&now).Error; err != nil {
		t.Fatal(err)
	}
	store := &countingInlineStore{next: ingestor.store}
	ingestor.store = store
	_, err := ingestor.IngestResult("user-1", map[string]interface{}{
		"items": []interface{}{
			map[string]interface{}{"dataUrl": tinyPNGDataURL},
			map[string]interface{}{"dataUrl": "data:video/mp4;base64,broken"},
		},
	}, IngestOptions{EnforceQuota: true, IdentityPrefix: "task-running"})
	if err == nil || !errors.Is(err, ErrInvalidGeneratedDataURL) {
		t.Fatalf("expected invalid data URL, got %v", err)
	}
	if store.upstreams.Load() != 0 {
		t.Fatalf("ingest triggered upstream persist = %d", store.upstreams.Load())
	}
	var task model.Task
	if err := db.First(&task, "id = ?", "task-running").Error; err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusRunning || strings.TrimSpace(task.ResultJSON) != "" {
		t.Fatalf("task mutated during ingest failure: %#v", task)
	}
	var results, representations int64
	if err := db.Model(&model.Result{}).Count(&results).Error; err != nil || results != 0 {
		t.Fatalf("results = %d err=%v", results, err)
	}
	if err := db.Model(&model.AssetRepresentation{}).Count(&representations).Error; err != nil || representations != 0 {
		t.Fatalf("representations = %d err=%v", representations, err)
	}
	listed, err := repo.Resources("user-1", 10)
	if err != nil || len(listed) != 1 {
		t.Fatalf("partial sibling persist = %d err=%v", len(listed), err)
	}
}

func TestIngestConcurrentIdentitiesStayIsolated(t *testing.T) {
	ingestor, _, repo, _, _ := newIngestHarness(t, ingestNopQuota{})
	const workers = 8
	ids := make([]string, workers)
	errs := make([]error, workers)
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		i := i
		go func() {
			defer wg.Done()
			result, err := ingestor.IngestResult("user-1", map[string]interface{}{
				"image": map[string]interface{}{"dataUrl": dataURL("image/png", []byte{byte(i), 1, 2, 3})},
			}, IngestOptions{EnforceQuota: true, IdentityPrefix: "task-" + strconv.Itoa(i)})
			if err != nil {
				errs[i] = err
				return
			}
			image, _ := result["image"].(map[string]interface{})
			ids[i], _ = image["resourceId"].(string)
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("worker %d: %v", i, err)
		}
	}
	seen := map[string]bool{}
	for i, id := range ids {
		if id == "" {
			t.Fatalf("worker %d stored empty id", i)
		}
		if seen[id] {
			t.Fatalf("workers shared resource %s", id)
		}
		seen[id] = true
	}
	listed, err := repo.Resources("user-1", 20)
	if err != nil || len(listed) != workers {
		t.Fatalf("concurrent resources = %d err=%v", len(listed), err)
	}
}

func TestDecodeInlineDataURLRejectsMalformed(t *testing.T) {
	if _, _, err := DecodeInlineDataURL("data:video/mp4;base64,broken"); err == nil || !errors.Is(err, ErrInvalidGeneratedDataURL) {
		t.Fatalf("broken = %v", err)
	}
	if _, _, err := DecodeInlineDataURL("https://example.com/a.png"); err == nil || !errors.Is(err, ErrInvalidGeneratedDataURL) {
		t.Fatalf("https = %v", err)
	}
	mime, data, err := DecodeInlineDataURL(tinyPNGDataURL)
	if err != nil || mime != "image/png" || len(data) == 0 {
		t.Fatalf("png = %q %d err=%v", mime, len(data), err)
	}
}

type countingInlineStore struct {
	next      InlineStore
	upstreams atomicInt
}

func (s *countingInlineStore) PersistInline(userID string, artifact InlineArtifact) (*model.Resource, error) {
	if s.next == nil {
		return nil, ErrIngestStoreMissing
	}
	return s.next.PersistInline(userID, artifact)
}

func (s *countingInlineStore) PersistRemoteArtifact(string, string, string, string) (*model.Resource, error) {
	s.upstreams.Add(1)
	panic("first-stage ingest must not persist remote artifacts")
}

func (s *countingInlineStore) Generate(string) (*model.Resource, error) {
	s.upstreams.Add(1)
	panic("ingest must not submit a provider generation")
}

type atomicInt struct{ n int }

func (a *atomicInt) Add(n int) { a.n += n }
func (a *atomicInt) Load() int { return a.n }

type ingestNopQuota struct{}

func (ingestNopQuota) ReserveUpload(string, int64, string) (string, error)         { return "day", nil }
func (ingestNopQuota) ReserveChunked(string, int64, string) (string, error)        { return "day", nil }
func (ingestNopQuota) ReserveRetry(string, int64, string) (string, error)          { return "day", nil }
func (ingestNopQuota) ReserveGenerated(string, int64, string) (string, error)      { return "day", nil }
func (ingestNopQuota) ReserveGeneratedRetry(string, int64, string) (string, error) { return "day", nil }
func (ingestNopQuota) Release(string, string, int64, string)                       {}
func (ingestNopQuota) ReleaseRetry(string, string, int64, string)                  {}
func (ingestNopQuota) Commit(string, int64, string)                                {}

type ingestRefuseQuota struct{ err error }

func (q ingestRefuseQuota) ReserveUpload(string, int64, string) (string, error) {
	return "", q.err
}
func (q ingestRefuseQuota) ReserveChunked(string, int64, string) (string, error) {
	return "", q.err
}
func (q ingestRefuseQuota) ReserveRetry(string, int64, string) (string, error) { return "", q.err }
func (q ingestRefuseQuota) ReserveGenerated(string, int64, string) (string, error) {
	return "", q.err
}
func (q ingestRefuseQuota) ReserveGeneratedRetry(string, int64, string) (string, error) {
	return "", q.err
}
func (ingestRefuseQuota) Release(string, string, int64, string)      {}
func (ingestRefuseQuota) ReleaseRetry(string, string, int64, string) {}
func (ingestRefuseQuota) Commit(string, int64, string)               {}

type ingestNopLifecycle struct{}

func (ingestNopLifecycle) RecordActivity(string, string, int) {}
func (ingestNopLifecycle) AfterResourceReady(*model.Resource) {}
func (ingestNopLifecycle) AppearanceReferencedIDs([]string) map[string]struct{} {
	return map[string]struct{}{}
}
func (ingestNopLifecycle) RecycleRetentionDays() (int, error)   { return 0, nil }
func (ingestNopLifecycle) WorkerID() string                     { return "ingest-test" }
func (ingestNopLifecycle) RunBackground(func())                 {}
func (ingestNopLifecycle) DeleteUserAsset(string, string) error { return nil }
func (l ingestNopLifecycle) WithStorageLock(fn func() error) error {
	if fn == nil {
		return nil
	}
	return fn()
}

func newIngestHarness(t *testing.T, quota asset.Quota) (*Ingestor, *asset.Service, *repository.Repository, *gorm.DB, string) {
	t.Helper()
	dir := t.TempDir()
	return openIngestHarness(t, filepath.Join(dir, "meta.db"), dir, quota)
}

func openIngestHarness(t *testing.T, dbPath, dataDir string, quota asset.Quota) (*Ingestor, *asset.Service, *repository.Repository, *gorm.DB, string) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(dbPath+"?_busy_timeout=5000&_foreign_keys=on"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Resource{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	assets := asset.NewService(asset.Dependencies{
		Repository: asset.NewRepository(repo),
		Blobs:      asset.NewFileStore(dataDir),
		Quota:      quota,
		Lifecycle:  ingestNopLifecycle{},
		DataDir:    dataDir,
	})
	ingestor := NewIngestor(IngestDeps{
		Store:      NewAssetInlineStore(assets),
		MaxBytes:   func() (int64, error) { return 64 << 20, nil },
		ProbeVideo: playback.ProbeGeneratedVideoMedia,
	})
	return ingestor, assets, repo, db, dataDir
}

func closeSQL(t *testing.T, db *gorm.DB) {
	t.Helper()
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
}

func nestedMap(t *testing.T, root map[string]interface{}, keys ...interface{}) map[string]interface{} {
	t.Helper()
	current := any(root)
	for _, key := range keys {
		switch k := key.(type) {
		case string:
			obj, _ := current.(map[string]interface{})
			current = obj[k]
		case int:
			arr, _ := current.([]interface{})
			current = arr[k]
		}
	}
	got, ok := current.(map[string]interface{})
	if !ok {
		t.Fatalf("nested %v = %#v", keys, current)
	}
	return got
}

func stringField(item map[string]interface{}, key string) string {
	text, _ := item[key].(string)
	return text
}

func uniqueResourceIDs(items ...map[string]interface{}) []string {
	seen := map[string]bool{}
	var ids []string
	for _, item := range items {
		id := stringField(item, "resourceId")
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids
}

func dataURL(mime string, data []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

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

func TestIngestResultJSONRoundTripKeepsDeterministicBytes(t *testing.T) {
	ingestor, _, _, _, _ := newIngestHarness(t, ingestNopQuota{})
	clip := syntheticVideoMP4(64, 32, 1000)
	result, err := ingestor.IngestResult("user-1", map[string]interface{}{
		"video": map[string]interface{}{"dataUrl": dataURL("video/mp4", clip)},
	}, IngestOptions{EnforceQuota: true})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "data:video/") {
		t.Fatalf("result still inline: %s", encoded)
	}
}
