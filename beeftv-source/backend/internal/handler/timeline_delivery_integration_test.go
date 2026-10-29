package handler

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/editing"
)

func TestDurableTimelineDeliveryUsesRealGoWorkerAndCanonicalSubtitleLines(t *testing.T) {
	for _, crash := range []bool{false, true} {
		name := "normal"
		if crash {
			name = "host_crash_after_render_admission"
		}
		t.Run(name, func(t *testing.T) { realTimelineDelivery(t, crash, false) })
	}
	t.Run("refresh_saved_timeline", func(t *testing.T) { realTimelineDelivery(t, false, true) })
}

func realTimelineDelivery(t *testing.T, crash, refresh bool) {
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	bin, err := editing.ResolveFFmpegBinary()
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(directory, "source.mp4")
	output, err := exec.Command(bin, "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=24:d=1",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source).CombinedOutput()
	if err != nil {
		t.Fatalf("source media: %v %s", err, output)
	}
	file, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	stat, _ := file.Stat()
	resource, err := env.service.UploadLocalResourceFile(owner.ID, "source.mp4", stat.Size(), "video", 320, 240, 1000, file)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	asset, _ := json.Marshal(map[string]any{"id": "source-asset", "title": "Source", "kind": "video", "resourceId": resource.ID, "coverUrl": "", "tags": []string{},
		"data": map[string]any{"storageKey": "resource:" + resource.ID, "width": 320, "height": 240, "bytes": resource.Size, "mimeType": resource.MimeType}})
	if _, err := env.service.UpsertUserAsset(owner.ID, asset); err != nil {
		t.Fatal(err)
	}
	current, err := env.service.UserCanvasProject(owner.ID, env.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var existing struct {
		Revision int64 `json:"revision"`
	}
	if err := json.Unmarshal(current, &existing); err != nil {
		t.Fatal(err)
	}
	doc, _ := json.Marshal(map[string]any{"id": env.canvasID, "title": "Delivery test", "revision": existing.Revision,
		"nodes": []any{map[string]any{"id": "source", "type": "video", "title": "Source", "metadata": map[string]any{"assetId": "source-asset", "storageKey": "resource:" + resource.ID}}}, "connections": []any{}})
	summary, err := env.service.UpsertUserCanvasProject(owner.ID, doc)
	if err != nil {
		t.Fatal(err)
	}
	if refresh {
		var document map[string]any
		if err := json.Unmarshal(doc, &document); err != nil {
			t.Fatal(err)
		}
		document["revision"] = summary.Revision
		document["nodes"] = append(document["nodes"].([]any), map[string]any{"id": "prior-film", "type": "video", "title": "Delivered film", "metadata": map[string]any{}})
		document["timeline"] = map[string]any{
			"version": 2, "durationMs": 1000, "output": map[string]any{"width": 320, "height": 240, "fps": 24},
			"tracks": []any{map[string]any{"id": "visual", "kind": "video"}, map[string]any{"id": "captions", "kind": "subtitle"}},
			"clips": []any{
				map[string]any{"id": "visual", "kind": "video", "nodeId": "source", "trackId": "visual", "startMs": 0, "durationMs": 1000, "volume": 0.35},
				map[string]any{"id": "caption", "kind": "subtitle", "trackId": "captions", "startMs": 0, "durationMs": 1000, "text": "First line\nSecond line"},
			},
		}
		doc, _ = json.Marshal(document)
		summary, err = env.service.UpsertUserCanvasProject(owner.ID, doc)
		if err != nil {
			t.Fatal(err)
		}
	}
	const turnID = "ccddee1122334455"
	env.beginTurn(t, turnID, assistantTurnInput(nil, nil))
	env.service.StartWorker()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = env.service.StopWorker(ctx)
	})
	renderAdmitted, release := make(chan struct{}), make(chan struct{})
	var interrupted atomic.Bool
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if crash && r.Method == http.MethodPost && r.URL.Path == "/api/ops/canvas.timeline.render" && interrupted.CompareAndSwap(false, true) {
			reply := httptest.NewRecorder()
			env.router.ServeHTTP(reply, r)
			if reply.Code == http.StatusOK {
				close(renderAdmitted)
				<-release // Host loses the accepted receipt, not the Go task.
			}
			for k, values := range reply.Header() {
				w.Header()[k] = values
			}
			w.WriteHeader(reply.Code)
			_, _ = w.Write(reply.Body.Bytes())
			return
		}
		env.router.ServeHTTP(w, r)
	}))
	defer backend.Close()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	settings := map[string]any{"root": root, "directory": directory, "backend": backend.URL + "/api", "canvasId": env.canvasID,
		"turnId": turnID, "hostToken": assistantTestHostToken, "revision": summary.Revision, "refresh": refresh}
	config, _ := json.Marshal(settings)
	configPath := filepath.Join(directory, "config.json")
	if err := os.WriteFile(configPath, config, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", filepath.Join(root, "agent-host/test-support/timeline-delivery-go-probe.mjs"), configPath)
	if crash {
		var output bytes.Buffer
		command.Stdout, command.Stderr = &output, &output
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		select {
		case <-renderAdmitted:
		case <-ctx.Done():
			_ = command.Process.Kill()
			_ = command.Wait()
			close(release)
			t.Fatalf("render not admitted before restart: %s", output.String())
		}
		_ = command.Process.Kill()
		_ = command.Wait()
		close(release)
		settings["resume"] = true
		config, _ = json.Marshal(settings)
		if err := os.WriteFile(configPath, config, 0600); err != nil {
			t.Fatal(err)
		}
		command = exec.CommandContext(ctx, "node", filepath.Join(root, "agent-host/test-support/timeline-delivery-go-probe.mjs"), configPath)
	}
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("real delivery: %v\n%s", err, output)
	}
	var result struct {
		TaskID  string `json:"taskId"`
		NodeID  string `json:"nodeId"`
		Project struct {
			ResourceID string `json:"resourceId"`
		} `json:"project"`
	}
	raw, err := os.ReadFile(filepath.Join(directory, "delivery-result.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	tasks, err := env.service.Tasks(owner.ID, 10)
	if err != nil || len(tasks) != 1 {
		t.Fatalf("unexpected tasks: %v %v", tasks, err)
	}
	task, err := env.service.Task(owner.ID, result.TaskID)
	if err != nil || task.Status != "succeeded" || task.Type != "timeline_render" {
		t.Fatalf("render not complete: %v %v", task, err)
	}
	canvas, err := env.service.UserCanvasProject(owner.ID, env.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var saved struct {
		Timeline editing.Project `json:"timeline"`
		Nodes    []struct {
			ID       string `json:"id"`
			Title    string `json:"title"`
			Metadata struct {
				TaskID     string `json:"taskId"`
				StorageKey string `json:"storageKey"`
			} `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(canvas, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Timeline.Clips[1].Text != "First line\nSecond line" {
		t.Fatalf("subtitle lines not canonical: %q", saved.Timeline.Clips[1].Text)
	}
	if refresh && (saved.Timeline.Clips[0].Volume != 0.35 || saved.Timeline.Clips[0].DirectMedia == nil || saved.Timeline.Clips[0].DirectMedia.ID != resource.ID) {
		t.Fatal("refresh lost the source or changed saved volume")
	}
	bound := false
	for _, node := range saved.Nodes {
		if node.ID == result.NodeID {
			bound = node.Metadata.TaskID == result.TaskID && strings.HasPrefix(node.Metadata.StorageKey, "resource:")
			if refresh && node.Title != "Delivered film · 2" {
				t.Fatalf("revision title collision not resolved: %q", node.Title)
			}
		}
	}
	if !bound {
		t.Fatal("delivered node is not bound to the original render")
	}
	plan, err := editing.Compile(saved.Timeline, nil, editing.Options{})
	if err != nil || !strings.Contains(plan.SubtitleSRT, "First line\nSecond line") {
		t.Fatalf("render text differs: %v", err)
	}
	_, body, err := env.service.OpenResource(owner.ID, result.Project.ResourceID)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := io.ReadAll(body)
	body.Close()
	if err != nil {
		t.Fatal(err)
	}
	z, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	projectJSON := false
	mediaFiles := 0
	for _, item := range z.File {
		stream, err := item.Open()
		if err != nil {
			t.Fatal(err)
		}
		var size int64
		if item.Name == "projects.json" {
			var document struct {
				Projects []struct {
					Project struct {
						Timeline editing.Project `json:"timeline"`
					} `json:"project"`
				} `json:"projects"`
			}
			err = json.NewDecoder(stream).Decode(&document)
			if err == nil && (len(document.Projects) != 1 || len(document.Projects[0].Project.Timeline.Clips) != 2 || document.Projects[0].Project.Timeline.Clips[1].Text != "First line\nSecond line") {
				t.Fatal("export lost canonical editable subtitles")
			}
			if err == nil {
				_, err = io.Copy(io.Discard, stream)
			} // Read through ZIP CRC.
		} else {
			size, err = io.Copy(io.Discard, stream)
			if size == 0 {
				t.Fatal("empty embedded media", item.Name)
			}
			mediaFiles++
		}
		stream.Close()
		if err != nil {
			t.Fatal(err)
		}
		projectJSON = projectJSON || item.Name == "projects.json"
	}
	if !projectJSON || mediaFiles < 2 {
		t.Fatal("editable project or embedded media missing")
	}
}
