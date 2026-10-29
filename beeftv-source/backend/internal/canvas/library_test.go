package canvas

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

func TestCanvasLibraryFolderAndDrawingPersistAndCAS(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	userID := "owner"
	folderRaw, _ := json.Marshal(map[string]any{"id": "folder-1", "name": "剧集"})
	folder, err := svc.UpsertUserCanvasFolder(userID, "folder-1", folderRaw)
	if err != nil || folder.Name != "剧集" || folder.ID != "folder-1" {
		t.Fatalf("folder upsert: %+v %v", folder, err)
	}
	canvasRaw := json.RawMessage(`{"id":"canvas","revision":0,"title":"分镜","folderId":"folder-1","nodes":[{"id":"n-drawing","type":"drawing","metadata":{"drawingId":"sketch"}}]}`)
	created, err := svc.UpsertUserCanvasProject(userID, canvasRaw)
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 1 {
		t.Fatalf("canvas revision = %d", created.Revision)
	}
	got, err := svc.UserCanvasProject(userID, "canvas")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(got, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["folderId"] != "folder-1" {
		t.Fatalf("folder overlay = %s", got)
	}

	drawingRaw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0,
		"snapshot":   map[string]any{"elements": []any{map[string]any{"id": "shape-1"}}},
		"shapeCount": 1, "pageCount": 1,
	})
	drawing, err := svc.UpsertUserCanvasDrawing(userID, "canvas", "sketch", drawingRaw)
	if err != nil || drawing.DrawingID != "sketch" || drawing.Revision != 1 {
		t.Fatalf("drawing create: %+v %v", drawing, err)
	}
	replay, err := svc.UpsertUserCanvasDrawing(userID, "canvas", "sketch", drawingRaw)
	if err != nil || replay.Revision != 1 || string(replay.Snapshot) != string(drawing.Snapshot) {
		t.Fatalf("identical replay: %+v %v", replay, err)
	}
	stale := append([]byte(nil), drawingRaw...)
	stale, _ = json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0,
		"snapshot":   map[string]any{"elements": []any{map[string]any{"id": "other"}}},
		"shapeCount": 1, "pageCount": 1,
	})
	_, err = svc.UpsertUserCanvasDrawing(userID, "canvas", "sketch", stale)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusConflict || appError.Reason != kernel.ReasonConflict {
		t.Fatalf("stale drawing save = %v", err)
	}
	loaded, err := svc.UserCanvasDrawing(userID, "canvas", "sketch")
	if err != nil || loaded.Revision != 1 || string(loaded.Snapshot) == "" {
		t.Fatalf("drawing read: %+v %v", loaded, err)
	}

	if err := svc.DeleteUserCanvasFolder(userID, "folder-1"); err != nil {
		t.Fatal(err)
	}
	cleared, err := svc.UserCanvasProject(userID, "canvas")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(cleared, &payload); err != nil {
		t.Fatal(err)
	}
	if folderID, _ := payload["folderId"].(string); folderID != "" {
		t.Fatalf("deleted folder still bound: %s", cleared)
	}
	if payload["revision"] != float64(2) {
		t.Fatalf("folder delete did not increment canvas revision: %s", cleared)
	}
	var stored model.CanvasProject
	if err := svc.repo.DB().First(&stored, "id = ? AND user_id = ?", "canvas", userID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.LibraryFolderID != "" || stored.Revision != 2 {
		t.Fatalf("canonical row = %+v", stored)
	}
	var storedPayload map[string]any
	if err := json.Unmarshal([]byte(stored.PayloadJSON), &storedPayload); err != nil {
		t.Fatal(err)
	}
	if folderID, _ := storedPayload["folderId"].(string); folderID != "" {
		t.Fatalf("stored payload still has folder: %s", stored.PayloadJSON)
	}
	history, err := svc.CanvasHistory(userID, "canvas")
	if err != nil || len(history.Snapshots) == 0 {
		t.Fatalf("folder delete history: %+v %v", history, err)
	}

	_, err = svc.UpsertUserCanvasFolder(userID, "folder-1", folderRaw)
	if !errors.As(err, &appError) || appError.Status != http.StatusConflict || appError.Reason != kernel.ReasonFailedPrecondition {
		t.Fatalf("folder revive = %v", err)
	}
	if err := svc.DeleteUserCanvasFolder(userID, "folder-1"); err != nil {
		t.Fatalf("idempotent folder delete: %v", err)
	}

	updateRaw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 1,
		"snapshot":   map[string]any{"elements": []any{map[string]any{"id": "shape-2"}}},
		"shapeCount": 1, "pageCount": 1,
	})
	updated, err := svc.UpsertUserCanvasDrawing(userID, "canvas", "sketch", updateRaw)
	if err != nil || updated.Revision != 2 {
		t.Fatalf("drawing update: %+v %v", updated, err)
	}
	replayUpdate, err := svc.UpsertUserCanvasDrawing(userID, "canvas", "sketch", updateRaw)
	if err != nil || replayUpdate.Revision != 2 || string(replayUpdate.Snapshot) != string(updated.Snapshot) {
		t.Fatalf("identical update replay: %+v %v", replayUpdate, err)
	}

	if err := svc.DeleteUserCanvasProject(userID, "canvas"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UserCanvasDrawing(userID, "canvas", "sketch"); err == nil {
		t.Fatal("drawing survived canvas delete")
	}
}

func TestCanvasSaveRejectsUnknownLibraryFolder(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	_, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","folderId":"missing","nodes":[]}`))
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusBadRequest {
		t.Fatalf("unknown folder = %v", err)
	}
}

func TestCanvasDrawingRejectsForeignPreviewResource(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.CreateResource(&model.Resource{ID: "res-1", UserID: "other", Kind: "image", Status: model.ResourceStatusReady}); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0, "snapshot": map[string]any{},
		"previewResourceId": "res-1",
	})
	_, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusBadRequest {
		t.Fatalf("foreign preview = %v", err)
	}
}

func TestCanvasDrawingRejectsForeignCanvas(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"drawingId": "sketch", "engine": "excalidraw", "revision": 0, "snapshot": map[string]any{}})
	_, err := svc.UpsertUserCanvasDrawing("other", "canvas", "sketch", raw)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusNotFound {
		t.Fatalf("foreign canvas = %v", err)
	}
}

func TestCanvasDrawingPreservesPromptLikeSnapshot(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0,
		"snapshot":   map[string]any{"elements": []any{map[string]any{"id": "text", "text": "data:image/png;base64,not-a-file"}}},
		"shapeCount": 1, "pageCount": 1,
	})
	saved, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot map[string]any
	if err := json.Unmarshal(saved.Snapshot, &snapshot); err != nil {
		t.Fatal(err)
	}
	elements := snapshot["elements"].([]any)
	text := elements[0].(map[string]any)["text"]
	if text != "data:image/png;base64,not-a-file" {
		t.Fatalf("snapshot text rewritten: %#v", text)
	}
}

func TestCanvasDrawingTombstoneBlocksRevisionZeroImport(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"drawingId": "sketch", "engine": "excalidraw", "revision": 0, "snapshot": map[string]any{"keep": true}})
	if _, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteUserCanvasDrawing("owner", "canvas", "sketch"); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteUserCanvasDrawing("owner", "canvas", "sketch"); err != nil {
		t.Fatalf("idempotent drawing delete: %v", err)
	}
	if _, err := svc.UserCanvasDrawing("owner", "canvas", "sketch"); err == nil {
		t.Fatal("tombstone readable")
	}
	listed, err := svc.UserCanvasDrawings("owner", "canvas")
	if err != nil || len(listed) != 0 {
		t.Fatalf("list after delete: %+v %v", listed, err)
	}
	_, err = svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusConflict || appError.Reason != kernel.ReasonFailedPrecondition {
		t.Fatalf("import after delete = %v", err)
	}
}

func TestCanvasDeleteRetainsDrawingTombstoneAcrossRecreate(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"drawingId": "sketch", "engine": "excalidraw", "revision": 0, "snapshot": map[string]any{"v": 1}})
	if _, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteUserCanvasProject("owner", "canvas"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"new","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	_, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Reason != kernel.ReasonFailedPrecondition {
		t.Fatalf("recreated canvas revived drawing: %v", err)
	}
}

func TestCanvasDrawingPreviewBlocksResourceCleanup(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	migrateUploadSettlementTables(t, svc.repo.DB())
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.CreateResource(&model.Resource{ID: "res-1", UserID: "owner", Kind: "image", Status: model.ResourceStatusReady}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpsertAsset(&model.Asset{ID: "asset-1", UserID: "owner", Title: "图", PayloadJSON: "{}"}); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0, "snapshot": map[string]any{},
		"previewResourceId": "res-1",
	})
	if _, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw); err != nil {
		t.Fatal(err)
	}
	snapshot, err := svc.repo.ResourceReferenceSnapshot("owner", "asset-1", []string{"res-1"})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ref := range snapshot.Direct {
		if ref.Kind == "画板预览" && ref.ResourceID == "res-1" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("missing drawing ref: %+v", snapshot.Direct)
	}
	if err := svc.repo.DeleteAssetAndResources("owner", "asset-1", []string{"res-1"}, nil); !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("delete while drawing refs resource = %v", err)
	}
	if err := svc.DeleteUserCanvasDrawing("owner", "canvas", "sketch"); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.DeleteAssetAndResources("owner", "asset-1", []string{"res-1"}, nil); err != nil {
		t.Fatalf("delete after drawing tombstone = %v", err)
	}
}

func TestCanvasFolderCoverBlocksResourceCleanup(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	migrateUploadSettlementTables(t, svc.repo.DB())
	if err := svc.repo.CreateResource(&model.Resource{ID: "cover-1", UserID: "owner", Kind: "image", Status: model.ResourceStatusReady}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpsertAsset(&model.Asset{ID: "asset-1", UserID: "owner", Title: "图", PayloadJSON: "{}"}); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"id": "folder-1", "name": "剧集", "coverResourceId": "cover-1"})
	if _, err := svc.UpsertUserCanvasFolder("owner", "folder-1", raw); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.DeleteAssetAndResources("owner", "asset-1", []string{"cover-1"}, nil); !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("delete while folder cover live = %v", err)
	}
	if err := svc.DeleteUserCanvasFolder("owner", "folder-1"); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.DeleteAssetAndResources("owner", "asset-1", []string{"cover-1"}, nil); err != nil {
		t.Fatalf("delete after folder tombstone = %v", err)
	}
}

func TestCanvasDrawingWriteAndResourceDeleteSerialize(t *testing.T) {
	a, b, db := newCanvasLibraryTestPair(t)
	migrateUploadSettlementTables(t, db)
	if _, err := a.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := a.repo.CreateResource(&model.Resource{ID: "res-1", UserID: "owner", Kind: "image", Status: model.ResourceStatusReady}); err != nil {
		t.Fatal(err)
	}
	if err := a.repo.UpsertAsset(&model.Asset{ID: "asset-1", UserID: "owner", Title: "图", PayloadJSON: "{}"}); err != nil {
		t.Fatal(err)
	}
	var events []string
	var eventMu sync.Mutex
	record := func(name string) {
		eventMu.Lock()
		events = append(events, name)
		eventMu.Unlock()
	}
	if err := db.Callback().Create().After("gorm:create").Register("test:library-drawing-create", func(tx *gorm.DB) {
		if tx.Statement != nil && tx.Statement.Table == "canvas_drawings" {
			record("drawing")
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Callback().Create().Remove("test:library-drawing-create") })

	raw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0, "snapshot": map[string]any{"n": 1},
		"previewResourceId": "res-1",
	})
	start := make(chan struct{})
	var writeErr, deleteErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, writeErr = a.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw)
	}()
	go func() {
		defer wg.Done()
		<-start
		deleteErr = b.repo.DeleteAssetAndResources("owner", "asset-1", []string{"res-1"}, nil)
	}()
	close(start)
	wg.Wait()

	_, drawingErr := a.UserCanvasDrawing("owner", "canvas", "sketch")
	_, resourceErr := a.repo.ResourceForUser("owner", "res-1")
	drawingLive := drawingErr == nil
	resourceLive := resourceErr == nil
	if drawingLive && !resourceLive {
		t.Fatalf("drawing refers to missing resource; write=%v delete=%v events=%v", writeErr, deleteErr, events)
	}
	if drawingLive && deleteErr == nil {
		t.Fatalf("resource deleted while drawing still references it; write=%v events=%v", writeErr, events)
	}
	if !drawingLive && resourceLive && writeErr == nil {
		t.Fatalf("write reported success without a live drawing; delete=%v events=%v", deleteErr, events)
	}
}

func TestCanvasLibraryCloseReopenRetainsSnapshotAndRefs(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	db := svc.repo.DB()
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.CreateResource(&model.Resource{ID: "res-1", UserID: "owner", Kind: "image", Status: model.ResourceStatusReady}); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0,
		"snapshot":          map[string]any{"keep": "yes"},
		"previewResourceId": "res-1",
	})
	saved, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw)
	if err != nil {
		t.Fatal(err)
	}
	path := ""
	var databases []struct {
		Seq  int
		Name string
		File string
	}
	if err := db.Raw("PRAGMA database_list").Scan(&databases).Error; err != nil {
		t.Fatal(err)
	}
	for _, item := range databases {
		if item.Name == "main" {
			path = item.File
		}
	}
	if path == "" {
		t.Fatal("missing sqlite file")
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := New(repository.New(mustOpenSQLite(t, path)), nil)
	loaded, err := reopened.UserCanvasDrawing("owner", "canvas", "sketch")
	if err != nil || loaded.Revision != saved.Revision || loaded.PreviewResourceID != "res-1" || string(loaded.Snapshot) == "" {
		t.Fatalf("reopen drawing: %+v %v", loaded, err)
	}
	snapshot, err := reopened.repo.ResourceReferenceSnapshot("owner", "", []string{"res-1"})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ref := range snapshot.Direct {
		if ref.ResourceID == "res-1" && ref.Kind == "画板预览" {
			found = true
		}
	}
	if !found {
		t.Fatalf("reopen lost resource ref: %+v", snapshot.Direct)
	}
}

func TestCanvasSaveRejectsTombstonedLibraryFolder(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	folderRaw, _ := json.Marshal(map[string]any{"id": "folder-1", "name": "剧集"})
	if _, err := svc.UpsertUserCanvasFolder("owner", "folder-1", folderRaw); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"分镜","folderId":"folder-1","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteUserCanvasFolder("owner", "folder-1"); err != nil {
		t.Fatal(err)
	}
	_, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":2,"title":"分镜","folderId":"folder-1","nodes":[]}`))
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusBadRequest {
		t.Fatalf("stale folder payload = %v", err)
	}
	saved, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":2,"title":"分镜","nodes":[]}`))
	if err != nil || saved.Revision != 3 || saved.FolderID != "" {
		t.Fatalf("unbind save: %+v %v", saved, err)
	}
}

func TestCanvasDrawingQuotaAdmitsByteDelta(t *testing.T) {
	host := &recordingQuotaHost{}
	svc := newCanvasHistoryTestService(t).WithHost(host)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0,
		"snapshot": map[string]any{"keep": true},
	})
	if _, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw); err != nil {
		t.Fatal(err)
	}
	if len(host.admits) != 1 || host.admits[0].kind != "canvas" || host.admits[0].creating || host.admits[0].delta <= 0 {
		t.Fatalf("quota admit = %+v", host.admits)
	}
}

func TestCanvasDrawingLargerThanEightMiBAcceptedWhenQuotaAllows(t *testing.T) {
	host := &limitedQuotaHost{limit: 16 << 20}
	svc := newCanvasHistoryTestService(t).WithHost(host)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0,
		"snapshot":   map[string]any{"pad": strings.Repeat("a", 9<<20)},
		"shapeCount": 1, "pageCount": 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) <= 8<<20 {
		t.Fatalf("fixture too small: %d", len(raw))
	}
	drawing, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw)
	if err != nil || drawing.Revision != 1 {
		t.Fatalf("9MiB drawing under 16MiB quota: %+v %v", drawing, err)
	}
}

func TestCanvasDrawingLargerThanEightMiBRejectedWhenQuotaExhausted(t *testing.T) {
	host := &limitedQuotaHost{limit: 8 << 20}
	svc := newCanvasHistoryTestService(t).WithHost(host)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0,
		"snapshot":   map[string]any{"pad": strings.Repeat("a", 9<<20)},
		"shapeCount": 1, "pageCount": 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Reason != kernel.ReasonQuotaExceeded {
		t.Fatalf("9MiB drawing over 8MiB quota = %v", err)
	}
	if strings.Contains(err.Error(), "画板数据超过 8MB") {
		t.Fatalf("independent 8MB cap still present: %v", err)
	}
}

func TestCanvasDrawingRejectsMalformedJSON(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	_, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", json.RawMessage(`{"drawingId":`))
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusBadRequest || appError.Error() != "画板数据格式错误" {
		t.Fatalf("malformed drawing json = %v", err)
	}
}

func TestCanvasDrawingRenderBlocksResourceCleanup(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	migrateUploadSettlementTables(t, svc.repo.DB())
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"x","nodes":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.CreateResource(&model.Resource{ID: "render-1", UserID: "owner", Kind: "image", Status: model.ResourceStatusReady}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpsertAsset(&model.Asset{ID: "asset-1", UserID: "owner", Title: "图", PayloadJSON: "{}"}); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{
		"drawingId": "sketch", "engine": "excalidraw", "revision": 0, "snapshot": map[string]any{},
		"render": map[string]any{"resourceId": "render-1", "background": "white"},
	})
	if _, err := svc.UpsertUserCanvasDrawing("owner", "canvas", "sketch", raw); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.DeleteAssetAndResources("owner", "asset-1", []string{"render-1"}, nil); !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("delete while render live = %v", err)
	}
}

type recordingQuotaHost struct {
	nopHost
	admits []quotaAdmit
}

type quotaAdmit struct {
	kind     string
	creating bool
	delta    int64
}

func (h *recordingQuotaHost) AdmitStructuredQuota(_ repository.UserStorageUsage, kind string, creating bool, deltaBytes int64) error {
	h.admits = append(h.admits, quotaAdmit{kind: kind, creating: creating, delta: deltaBytes})
	return nil
}

type limitedQuotaHost struct {
	nopHost
	limit int64
}

func (h *limitedQuotaHost) AdmitStructuredQuota(usage repository.UserStorageUsage, _ string, _ bool, deltaBytes int64) error {
	if usage.AssetBytes+usage.CanvasBytes+deltaBytes > h.limit {
		mb := h.limit >> 20
		if mb < 1 {
			mb = 1
		}
		return kernel.QuotaExceeded(fmt.Sprintf("账号画布和素材数据已达到 %dMB 上限，请先删除不需要的内容", mb))
	}
	return nil
}
