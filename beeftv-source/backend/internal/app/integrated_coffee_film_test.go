package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
)

// Opt-in real-media acceptance fixture: source bytes are existing coffee shots,
// never an old experimental final film. The output database/resources persist.
func TestIntegratedCoffeeFilmBusinessOperations(t *testing.T) {
	out := os.Getenv("BEEFTV_INTEGRATED_FILM_OUTPUT")
	manifest := os.Getenv("BEEFTV_COFFEE_ASSETS_MANIFEST")
	if out == "" || manifest == "" {
		t.Skip("set explicit source manifest and output directory for OUT01 acceptance")
	}
	if err := os.MkdirAll(out, 0700); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(out, "business.sqlite")
	if _, err := os.Stat(dbPath); err == nil {
		t.Fatal("refuse to overwrite an earlier acceptance database")
	}
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	if err := db.AutoMigrate(database.LocalModels()...); err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), filepath.Join(out, "local-data"))
	if err := db.Create(&model.Workspace{ID: "coffee-owner", Name: "Coffee acceptance"}).Error; err != nil {
		t.Fatal(err)
	}
	var sources []struct {
		ID, Path, SHA256 string
		Duration         float64
	}
	raw, err := os.ReadFile(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &sources); err != nil {
		t.Fatal(err)
	}
	if len(sources) != 4 {
		t.Fatalf("expected four original shots, got %d", len(sources))
	}
	writeJSON := func(name string, value any) {
		t.Helper()
		b, e := json.MarshalIndent(value, "", "  ")
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(out, name), b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	nodes := []any{}
	for _, source := range sources {
		f, e := os.Open(source.Path)
		if e != nil {
			t.Fatal(e)
		}
		h := sha256.New()
		if _, e = io.Copy(h, f); e != nil {
			f.Close()
			t.Fatal(e)
		}
		if hex.EncodeToString(h.Sum(nil)) != source.SHA256 {
			f.Close()
			t.Fatal("source hash mismatch: " + source.ID)
		}
		if _, e = f.Seek(0, 0); e != nil {
			f.Close()
			t.Fatal(e)
		}
		stat, _ := f.Stat()
		facts, e := editing.Probe(context.Background(), source.Path)
		if e != nil {
			f.Close()
			t.Fatal(e)
		}
		resource, e := svc.UploadLocalResourceFile("coffee-owner", filepath.Base(source.Path), stat.Size(), "video", 0, 0, facts.DurationMs, f)
		f.Close()
		if e != nil {
			t.Fatal(e)
		}
		assetID := "coffee-" + source.ID
		payload, _ := json.Marshal(map[string]any{"resourceId": resource.ID})
		if e = db.Create(&model.Asset{ID: assetID, UserID: "coffee-owner", Kind: "video", PayloadJSON: string(payload)}).Error; e != nil {
			t.Fatal(e)
		}
		nodes = append(nodes, map[string]any{"id": source.ID, "type": "video", "title": source.ID, "metadata": map[string]any{"storageKey": "resource:" + resource.ID, "assetId": assetID}})
	}
	raw, _ = json.Marshal(map[string]any{"id": "coffee-canvas", "title": "A moment for coffee", "revision": 0, "nodes": nodes, "connections": []any{}})
	summary, err := svc.UpsertUserCanvasProject("coffee-owner", raw)
	if err != nil {
		t.Fatal(err)
	}
	registry := operations.NewRegistry(svc, operations.NewStore(db))
	operations.RegisterDefaultOps(registry)
	scope := &agentops.AssistantScope{CanvasID: "coffee-canvas"}
	turnID := "c0ffee001234abcd"
	if _, err := svc.BeginAssistantTurn("coffee-owner", "coffee-canvas", turnID, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	receipts := []any{}
	mediaResult := func(result any) operations.MediaResult {
		t.Helper()
		encoded, e := json.Marshal(result)
		if e != nil {
			t.Fatal(e)
		}
		var value operations.MediaResult
		if e = json.Unmarshal(encoded, &value); e != nil {
			t.Fatal(e)
		}
		return value
	}
	call := func(op, id string, params map[string]any) operations.Result {
		t.Helper()
		body, _ := json.Marshal(params)
		res, e := registry.Execute(operations.Request{Context: context.Background(), UserID: "coffee-owner", Caller: operations.AssistantCaller(scope, false), TurnID: turnID, Op: op, OpID: id, Params: body})
		if e != nil {
			t.Fatalf("%s: %v", op, e)
		}
		// Preview content is actual bytes but is not duplicated into the public receipt.
		public := res.Result
		if op == "media.overview" || op == "media.inspect" || op == "media.check" {
			media := mediaResult(res.Result)
			parts := []any{}
			for _, p := range media.Content {
				parts = append(parts, map[string]any{"type": p.Type, "mimeType": p.MimeType, "sha256": p.SHA256, "source": p.Source, "encodedBytes": len(p.Data)})
			}
			public = map[string]any{"source": media.Source, "durationMs": media.DurationMs, "hasVideo": media.HasVideo, "hasAudio": media.HasAudio, "content": parts, "blackIntervals": media.BlackIntervals, "meanDb": media.MeanDB, "peakDb": media.PeakDB}
		}
		receipts = append(receipts, map[string]any{"operation": op, "operationId": id, "params": params, "revision": res.Revision, "replayed": res.Replayed, "result": public})
		writeJSON("operation-receipts.json", receipts)
		return res
	}
	for _, source := range sources {
		params := map[string]any{"canvasId": "coffee-canvas", "nodeId": source.ID}
		media := mediaResult(call("media.overview", "", params).Result)
		if !media.HasVideo || !media.HasAudio || media.DurationMs < 4500 {
			t.Fatalf("unexpected original source facts: %+v", media)
		}
		params["expectedVersion"] = media.Source.Version
		params["startMs"] = 0
		params["endMs"] = 3000
		params["mode"] = "audio"
		call("media.inspect", "", params)
	}
	visible := true
	project := editing.Project{Version: 2, DurationMs: 12000, Tracks: []editing.Track{{ID: "coffee-video", Kind: "video", Visible: &visible}}}
	for i, source := range sources {
		project.Clips = append(project.Clips, editing.Clip{ID: fmt.Sprintf("coffee-clip-%d", i+1), Kind: "video", NodeID: source.ID, TrackID: "coffee-video", StartMs: int64(i) * 3000, DurationMs: 3000, SourceDurationMs: 5056, Volume: 1})
	}
	render := func(name string, timeline editing.Project) (editing.Project, string) {
		t.Helper()
		saved := call("canvas.timeline.update", name+"-edit", map[string]any{"canvasId": "coffee-canvas", "expectedRevision": summary.Revision, "timeline": timeline})
		summary.Revision = saved.Revision
		canvasRaw, e := svc.UserCanvasProject("coffee-owner", "coffee-canvas")
		if e != nil {
			t.Fatal(e)
		}
		var stored struct {
			Timeline editing.Project `json:"timeline"`
		}
		if e = json.Unmarshal(canvasRaw, &stored); e != nil {
			t.Fatal(e)
		}
		writeJSON(name+"-editing-project.json", stored.Timeline)
		if e = os.WriteFile(filepath.Join(out, name+"-canvas.json"), canvasRaw, 0600); e != nil {
			t.Fatal(e)
		}
		renderParams := map[string]any{"canvasId": "coffee-canvas", "expectedRevision": summary.Revision, "options": editing.Options{Width: 854, Height: 480, FPS: 24}}
		admitted := call("canvas.timeline.render", name+"-render", renderParams)
		if admitted.Result.(map[string]any)["charged"] != false {
			t.Fatal("render must be free")
		}
		replay := call("canvas.timeline.render", name+"-render", renderParams)
		if !replay.Replayed {
			t.Fatal("render dedup failed")
		}
		taskID := admitted.Result.(map[string]any)["taskId"].(string)
		trusted, ok, e := svc.AssistantTurnScopeForHost("coffee-owner", turnID)
		if e != nil || !ok {
			t.Fatal("task scope not available", e)
		}
		scope.TaskIDs = map[string]bool{}
		for _, id := range trusted.TaskIDs {
			scope.TaskIDs[id] = true
		}
		var task model.Task
		if e = db.First(&task, "id = ?", taskID).Error; e != nil {
			t.Fatal(e)
		}
		if task.Provider != "local" || task.Model != "ffmpeg" {
			t.Fatal("unexpected paid/external task")
		}
		if e = db.Model(&task).Update("status", model.TaskStatusRunning).Error; e != nil {
			t.Fatal(e)
		}
		task.Status = model.TaskStatusRunning
		if e = newTaskWorkerCoordinator(svc).processTimelineRender(&task, context.Background()); e != nil {
			t.Fatal(e)
		}
		if e = db.First(&task, "id = ?", taskID).Error; e != nil {
			t.Fatal(e)
		}
		if task.Status != model.TaskStatusSucceeded {
			t.Fatalf("render: %s", task.Error)
		}
		queried := call("task.get", "", map[string]any{"taskId": taskID})
		outputJSON, _ := json.Marshal(queried.Result.(map[string]any)["outputs"])
		var outputs []model.TaskOutput
		json.Unmarshal(outputJSON, &outputs)
		if len(outputs) != 1 || outputs[0].ResourceID == "" || outputs[0].MaterializedAssetID == "" {
			t.Fatalf("undelivered: %s", outputJSON)
		}
		created := call("canvas.nodes.create", name+"-preview", map[string]any{"canvasId": "coffee-canvas", "expectedRevision": summary.Revision, "nodes": []any{map[string]any{"type": "video", "title": name + " · Coffee"}}})
		summary.Revision = created.Revision
		previewID := created.Result.(map[string]any)["created"].([]any)[0].(map[string]any)["id"].(string)
		bound := call("canvas.task.bind", localtask.AttachNodeEffectKey(taskID, previewID, 0), map[string]any{"canvasId": "coffee-canvas", "taskId": taskID, "nodeId": previewID, "outputIndex": 0})
		summary.Revision = bound.Revision
		if bound.Result.(map[string]any)["bindingStatus"] != "bound" {
			t.Fatal("not bound")
		}
		_, reader, e := svc.OpenResource("coffee-owner", outputs[0].ResourceID)
		if e != nil {
			t.Fatal(e)
		}
		path := filepath.Join(out, name+".mp4")
		file, e := os.Create(path)
		if e != nil {
			reader.Close()
			t.Fatal(e)
		}
		_, e = io.Copy(file, reader)
		file.Close()
		reader.Close()
		if e != nil {
			t.Fatal(e)
		}
		facts, e := editing.Probe(context.Background(), path)
		if e != nil {
			t.Fatal(e)
		}
		if facts.DurationMs < 11900 || facts.DurationMs > 12200 || !facts.HasAudio || !facts.HasVideo {
			t.Fatalf("invalid final facts %+v", facts)
		}
		bin, e := editing.ResolveFFmpegBinary()
		if e != nil {
			t.Fatal(e)
		}
		decoded, e := exec.Command(bin, "-nostdin", "-v", "error", "-i", path, "-f", "null", "-").CombinedOutput()
		if e != nil || len(decoded) != 0 {
			t.Fatalf("decode failed %v %s", e, decoded)
		}
		params := map[string]any{"canvasId": "coffee-canvas", "nodeId": previewID}
		overview := mediaResult(call("media.overview", "", params).Result)
		params["expectedVersion"] = overview.Source.Version
		params["endMs"] = facts.DurationMs
		checked := mediaResult(call("media.check", "", params).Result)
		if len(checked.BlackIntervals) > 0 || checked.PeakDB == nil || *checked.PeakDB < -60 {
			t.Fatalf("black/silent film %+v", checked)
		}
		writeJSON(name+"-validation.json", map[string]any{"facts": facts, "decoded": true, "blackIntervals": checked.BlackIntervals, "meanDb": checked.MeanDB, "peakDb": checked.PeakDB, "taskId": taskID, "previewNodeId": previewID, "resourceId": outputs[0].ResourceID, "charged": false})
		return stored.Timeline, previewID
	}
	initial, _ := render("initial", project)
	revised := initial
	revised.Clips = append([]editing.Clip{}, initial.Clips...)
	revised.Clips[1].SourceStartMs = 1500
	revised.Clips[1].Volume = 0.5
	final, _ := render("revised", revised)
	for i := range initial.Clips {
		if i != 1 && !reflect.DeepEqual(initial.Clips[i], final.Clips[i]) {
			t.Fatal("local revision changed another shot")
		}
	}
	if err := svc.FinalizeAssistantTurn(turnID); err != nil {
		t.Fatal(err)
	}
	finalCanvas, err := svc.UserCanvasProject("coffee-owner", "coffee-canvas")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, "editable-canvas.json"), finalCanvas, 0600); err != nil {
		t.Fatal(err)
	}
	writeJSON("source-manifest.json", sources)
	var tasks []model.Task
	if err := db.Find(&tasks).Error; err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 2 {
		t.Fatal("unexpected task count")
	}
	writeJSON("task-receipts.json", tasks)
	t.Logf("OUT01 real operations and two native renders saved in %s", out)
}
