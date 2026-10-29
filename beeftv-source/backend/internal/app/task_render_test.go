package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
)

// renderTestProject 构造一个可渲染的 v2 快照：一条可见视频轨 + 一个
// 经 directMedia.storageKey（resource:<id>）引用后端资源的片段。
func renderTestProject(storageKey string) editing.Project {
	visible := true
	return editing.Project{
		Version:    2,
		DurationMs: 2000,
		Tracks:     []editing.Track{{ID: "track-v1", Kind: "video", Visible: &visible}},
		Clips: []editing.Clip{{
			ID:            "clip-v1",
			Kind:          "video",
			TrackID:       "track-v1",
			StartMs:       0,
			DurationMs:    2000,
			SourceStartMs: 0,
			Volume:        1,
			NodeID:        "clip-v1",
			DirectMedia:   &editing.DirectMedia{ID: "asset-v1", Kind: "video", StorageKey: storageKey},
		}},
	}
}

func renderInputJSON(t *testing.T, project editing.Project) string {
	t.Helper()
	raw, err := json.Marshal(timelineRenderInput{ProjectID: "prj-render", Timeline: project})
	if err != nil {
		t.Fatalf("marshal render input: %v", err)
	}
	return string(raw)
}

func seedRunningRenderTask(t *testing.T, db *gorm.DB, inputJSON string) *model.Task {
	t.Helper()
	task := &model.Task{
		ID:        fmt.Sprintf("tsk-render-%d", time.Now().UnixNano()),
		UserID:    "usr-render-test",
		Type:      model.TaskTypeTimelineRender,
		Status:    model.TaskStatusRunning,
		Stage:     "已领取",
		InputJSON: inputJSON,
	}
	if err := db.Create(task).Error; err != nil {
		t.Fatalf("seed task: %v", err)
	}
	return task
}

func TestCreateTimelineRenderTaskQueues(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	seedActiveProject(t, db, "prj-render", "usr-render-test")
	seedResource(t, db, "res-1", "usr-render-test", "video/mp4")

	task, err := svc.CreateTimelineRenderTask("usr-render-test", TimelineRenderCreateRequest{
		ProjectID: "prj-render",
		Timeline:  renderTestProject("resource:res-1"),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if task.Type != model.TaskTypeTimelineRender || task.Status != model.TaskStatusQueued {
		t.Fatalf("task = %s/%s, want %s/queued", task.Type, task.Status, model.TaskTypeTimelineRender)
	}
	if task.Provider != "local" || task.Model != "ffmpeg" {
		t.Fatalf("provider/model = %s/%s, want local/ffmpeg", task.Provider, task.Model)
	}

	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatalf("load task: %v", err)
	}
	if stored.ProjectID != "prj-render" || stored.UserID != "usr-render-test" {
		t.Fatalf("stored owner/project mismatch: %s/%s", stored.UserID, stored.ProjectID)
	}
}

func TestCompileTimelineRenderPlanUsesOpaqueSources(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	hasAudio := true
	hasVideo := true
	plan, err := svc.CompileTimelineRenderPlan("usr-render-test", TimelineRenderPlanRequest{
		Timeline: renderTestProject("resource:res-1"),
		Sources:  []editing.SourceMeta{{ID: "clip-v1", HasAudio: &hasAudio, HasVideo: &hasVideo, DurationMs: 4000}},
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if plan.Version != editing.PlanVersion || plan.Segments[0].SourceID != "clip-v1" {
		t.Fatalf("plan=%+v", plan)
	}
	var tasks int64
	if err := db.Model(&model.Task{}).Count(&tasks).Error; err != nil || tasks != 0 {
		t.Fatalf("planning created a task: %d %v", tasks, err)
	}
	if _, err := svc.CompileTimelineRenderPlan("", TimelineRenderPlanRequest{Timeline: renderTestProject("resource:res-1")}); err == nil {
		t.Fatal("empty user accepted")
	}
}

func TestCreateTimelineRenderTaskRejectsUnknownResource(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	seedActiveProject(t, db, "prj-render", "usr-render-test")

	_, err := svc.CreateTimelineRenderTask("usr-render-test", TimelineRenderCreateRequest{
		ProjectID: "prj-render",
		Timeline:  renderTestProject("resource:res-1"),
	})
	if err == nil {
		t.Fatal("unknown resource admitted")
	}
}

func TestCreateTimelineRenderTaskRejectsNoMedia(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)

	visible := true
	textOnly := editing.Project{
		Version:    2,
		DurationMs: 1000,
		Tracks:     []editing.Track{{ID: "track-t1", Kind: "text", Visible: &visible}},
		Clips: []editing.Clip{{
			ID: "clip-t1", Kind: "text", TrackID: "track-t1", StartMs: 0,
			DurationMs: 1000, Text: "字幕",
		}},
	}
	_, err := svc.CreateTimelineRenderTask("usr-render-test", TimelineRenderCreateRequest{Timeline: textOnly})
	if err == nil || (!strings.Contains(err.Error(), "可渲染") && !strings.Contains(err.Error(), "不支持")) {
		t.Fatalf("err = %v, want unsupported kind or no renderable media", err)
	}
}

func TestCreateTimelineRenderTaskCarriesOptions(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	seedActiveProject(t, db, "prj-render", "usr-render-test")
	seedResource(t, db, "res-1", "usr-render-test", "video/mp4")
	burn := false
	task, err := svc.CreateTimelineRenderTask("usr-render-test", TimelineRenderCreateRequest{
		ProjectID: "prj-render",
		Timeline:  renderTestProject("resource:res-1"),
		Options:   editing.Options{Width: 1280, Height: 720, FPS: 24, SampleRate: 48000, BurnSubtitles: &burn},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatalf("load task: %v", err)
	}
	var input timelineRenderInput
	if err := json.Unmarshal([]byte(stored.InputJSON), &input); err != nil {
		t.Fatalf("input: %v", err)
	}
	if input.Options.Width != 1280 || input.Options.Height != 720 || input.Options.FPS != 24 || input.Options.SampleRate != 48000 || input.Options.BurnSubtitles == nil || *input.Options.BurnSubtitles {
		t.Fatalf("options not stored: %+v", input.Options)
	}
}

func TestTimelineRenderRejectsMalformedBeforeFFmpeg(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	project := renderTestProject("resource:res-1")
	project.Clips[0].Kind = "text"
	task := seedRunningRenderTask(t, db, renderInputJSON(t, project))
	t.Setenv(editing.FFmpegPathEnv, "/no/such/ffmpeg")
	w := newTaskWorkerCoordinator(svc)
	if err := w.processTimelineRender(task, context.Background()); err != nil {
		t.Fatalf("process: want nil (task terminal handled internally), got %v", err)
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatalf("load task: %v", err)
	}
	if stored.Status != model.TaskStatusFailed {
		t.Fatalf("status = %q, want failed", stored.Status)
	}
	if !strings.Contains(stored.Error, "不支持") {
		t.Fatalf("error = %q, want unsupported kind before ffmpeg", stored.Error)
	}
}

func TestTimelineRenderFailsFastWhenSourceUnreadable(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	// 指向不存在的资源；ffmpeg 路径设为无效值不影响断言——本测试在
	// 素材落盘（materialize）阶段即失败，且该失败早于任何外部命令执行。
	task := seedRunningRenderTask(t, db, renderInputJSON(t, renderTestProject("resource:res-missing")))

	t.Setenv(editing.FFmpegPathEnv, "/no/such/ffmpeg")
	w := newTaskWorkerCoordinator(svc)
	if err := w.processTimelineRender(task, context.Background()); err != nil {
		t.Fatalf("process: want nil (task terminal handled internally), got %v", err)
	}

	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatalf("load task: %v", err)
	}
	if stored.Status != model.TaskStatusFailed {
		t.Fatalf("status = %q, want failed", stored.Status)
	}
	if !strings.Contains(stored.Error, "时间线引用的媒体") {
		t.Fatalf("error = %q, want mention of 无法读取时间线引用的媒体", stored.Error)
	}
}

func TestTimelineRenderReplaysRecoveredIdentityWithoutFFmpeg(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	svc.dataDir = t.TempDir()
	task := seedRunningRenderTask(t, db, renderInputJSON(t, renderTestProject("resource:res-missing")))
	payload := []byte("recovered-render-bytes")
	resource, err := svc.resourceDomain().RecoverOwned(task.UserID, timelineRenderArtifactIdentity(task.ID), func() (localasset.RecoveredArtifact, error) {
		return localasset.RecoveredArtifact{
			Kind: "video", FileName: timelineRenderFileName, MimeType: "video/mp4",
			Size: int64(len(payload)), Width: 320, Height: 180, DurationMs: 2000,
			Body: bytes.NewReader(payload),
		}, nil
	})
	if err != nil || resource == nil {
		t.Fatalf("seed recovered output: %v", err)
	}

	t.Setenv(editing.FFmpegPathEnv, "/no/such/ffmpeg")
	w := newTaskWorkerCoordinator(svc)
	if err := w.processTimelineRender(task, context.Background()); err != nil {
		t.Fatalf("process: %v", err)
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatalf("load task: %v", err)
	}
	if stored.Status != model.TaskStatusSucceeded {
		t.Fatalf("status = %q error=%q, want succeeded without re-render", stored.Status, stored.Error)
	}
	var result timelineRenderResult
	if err := json.Unmarshal([]byte(stored.ResultJSON), &result); err != nil {
		t.Fatalf("result: %v", err)
	}
	if result.ResourceID != resource.ID || result.FileName != timelineRenderFileName {
		t.Fatalf("result=%+v want resource %s", result, resource.ID)
	}
}
