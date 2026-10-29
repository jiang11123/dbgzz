package task

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/depthcapture"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

type unusedGenerationCatalog struct{}

func (unusedGenerationCatalog) Select(string, SelectRequest) (SelectResult, error) {
	panic("local executor admission must not select a model catalog route")
}
func (unusedGenerationCatalog) PrepareRetry(*model.Task, map[string]any) error {
	panic("local executor admission must not prepare catalog retry")
}
func (unusedGenerationCatalog) RequireCustomChannels(map[string]any) error {
	panic("local executor admission must not require custom channels")
}
func (unusedGenerationCatalog) ValidateCapability(map[string]any) error {
	panic("local executor admission must not validate provider capability")
}
func (unusedGenerationCatalog) HasExecutableVideoConfig(map[string]any) bool {
	panic("local executor admission must not inspect video config")
}

type unusedGenerationSecrets struct{}

func (unusedGenerationSecrets) ResolveManaged(map[string]any) (map[string]any, error) {
	panic("local executor admission must not resolve provider secrets")
}
func (unusedGenerationSecrets) Protect(map[string]any) error {
	panic("local executor admission must not protect provider secrets")
}
func (unusedGenerationSecrets) DecryptInputJSON(string) (string, error) {
	panic("local executor admission must not decrypt provider input")
}

type unusedGenerationMedia struct{}

func (unusedGenerationMedia) ValidateTransport(string, map[string]any) error {
	panic("unexpected generation media validation")
}

func (unusedGenerationMedia) ContainsInlineData(map[string]any) bool {
	panic("local executor admission must not inspect generation inline media")
}

type unusedGenerationReplay struct{}

func (unusedGenerationReplay) IsRequest(map[string]any) bool {
	panic("local executor admission must not inspect text replay")
}
func (unusedGenerationReplay) Finalize(string, model.TaskStatus) error {
	panic("local executor admission must not finalize text replay")
}

type allowFeatures struct{}

func (allowFeatures) Require(string) error { return nil }

type captureFeatures struct{ name string }

func (c *captureFeatures) Require(name string) error {
	c.name = name
	return nil
}

type denyFeatures struct{ err error }

func (d denyFeatures) Require(string) error { return d.err }

type memOwnedMedia struct {
	mu    sync.Mutex
	items map[string]model.Resource
}

func newMemOwnedMedia() *memOwnedMedia {
	return &memOwnedMedia{items: map[string]model.Resource{}}
}

func (m *memOwnedMedia) put(userID string, resource model.Resource) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.items[opKey(userID, resource.ID)] = resource
}

func (m *memOwnedMedia) Resource(userID, id string) (*model.Resource, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	resource, ok := m.items[opKey(userID, id)]
	if !ok {
		return nil, errors.New("record not found")
	}
	copied := resource
	return &copied, nil
}

func specializedDeps(persist Persistence, media OwnedMedia, runtime Runtime) Dependencies {
	return Dependencies{
		Catalog:    unusedGenerationCatalog{},
		Secrets:    unusedGenerationSecrets{},
		Media:      unusedGenerationMedia{},
		TextReplay: unusedGenerationReplay{},
		Projects:   allowProjects{},
		Policy:     staticPolicy{limit: 8},
		Persist:    persist,
		Runtime:    runtime,
		Present:    identityPresent{},
		OwnedMedia: media,
		Features:   allowFeatures{},
		NewID:      kernel.NewID,
	}
}

func newSpecializedMem(extra func(*Dependencies, *memOwnedMedia, *drainRuntime)) (*Service, *memStore, *memOwnedMedia, *drainRuntime) {
	store := newMemStore()
	media := newMemOwnedMedia()
	runtime := &drainRuntime{}
	deps := specializedDeps(store, media, runtime)
	if extra != nil {
		extra(&deps, media, runtime)
	}
	return NewService(store, deps), store, media, runtime
}

func renderableTimeline(storageKey string) editing.Project {
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

func readyVideo(id string) model.Resource {
	return model.Resource{ID: id, Kind: "video", Status: model.ResourceStatusReady, Provider: "local", MimeType: "video/mp4", Size: 1024}
}

func TestValidateLocalExecutorTypeAllowlist(t *testing.T) {
	for _, taskType := range []string{model.TaskTypeTimelineRender, model.TaskTypeTimelineTranscription, model.TaskTypeDepthCapture} {
		if err := ValidateLocalExecutorType(taskType); err != nil {
			t.Fatalf("%s: %v", taskType, err)
		}
		if err := ValidateType(taskType); err == nil || !strings.Contains(err.Error(), "不支持的任务类型") {
			t.Fatalf("generation allowlist accepted %s: %v", taskType, err)
		}
	}
	if err := ValidateLocalExecutorType("canvas_image"); err == nil || !strings.Contains(err.Error(), "不支持的本地执行任务类型") {
		t.Fatalf("local allowlist error = %v", err)
	}
}

func TestGenerationCreateTaskRejectsLocalExecutorTypes(t *testing.T) {
	svc, store, _, _ := newSpecializedMem(nil)
	for _, taskType := range []string{model.TaskTypeTimelineRender, model.TaskTypeTimelineTranscription, model.TaskTypeDepthCapture} {
		_, err := svc.CreateTask("user", CreateRequest{Type: taskType, Prompt: "本地执行", ProjectID: "prj-1"})
		if err == nil || !strings.Contains(err.Error(), "不支持的任务类型") {
			t.Fatalf("%s generation error = %v", taskType, err)
		}
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatalf("generation wrote local executor rows: %+v", listed)
	}
}

func TestSpecializedAdmissionUsesFixedSchemaWithoutCatalog(t *testing.T) {
	svc, store, media, _ := newSpecializedMem(nil)
	media.put("user", readyVideo("res-1"))

	render, err := svc.CreateTimelineRenderTask("user", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-1"),
		TraceID: "tr-render", RequestID: "req-render",
	})
	if err != nil {
		t.Fatal(err)
	}
	if render.Type != model.TaskTypeTimelineRender || render.Provider != LocalExecutorRenderProvider || render.Model != LocalExecutorRenderModel {
		t.Fatalf("render schema = %s/%s/%s", render.Type, render.Provider, render.Model)
	}
	if render.Prompt != LocalExecutorRenderPrompt || render.Stage != LocalExecutorQueuedStage || render.Progress != 5 {
		t.Fatalf("render presentation = %+v", render)
	}
	if render.TraceID != "tr-render" || render.RequestID != "req-render" || render.LogicalModelID != "" {
		t.Fatalf("render identity = %+v", render)
	}

	trans, err := svc.CreateTimelineTranscriptionTask("user", TimelineTranscriptionCreateRequest{
		ResourceID: "res-1", Language: "zh", ProjectID: "prj-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if trans.Provider != LocalExecutorTranscriptionProvider || trans.Model != LocalExecutorTranscriptionModel || trans.Prompt != LocalExecutorTranscriptionPrompt {
		t.Fatalf("transcription schema = %+v", trans)
	}

	depth, err := svc.CreateDepthCaptureTask("user", DepthCaptureCreateRequest{ProjectID: "prj-1", ResourceID: "res-1"})
	if err != nil {
		t.Fatal(err)
	}
	if depth.Provider != depthcapture.Provider || depth.Model != depthcapture.ModelID || depth.Stage != depthcapture.InitialStage || depth.Progress != 0 {
		t.Fatalf("depth schema = %+v", depth)
	}
	var depthInput depthcapture.Input
	if err := json.Unmarshal([]byte(mustTask(t, store, depth.ID).InputJSON), &depthInput); err != nil {
		t.Fatal(err)
	}
	if depthInput.ResourceID != "res-1" || depthInput.Profile != depthcapture.StandardProfile {
		t.Fatalf("depth input = %+v", depthInput)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 3 {
		t.Fatalf("stored = %d", len(listed))
	}
}

func TestSpecializedAdmissionAllowsNilGenerationCollaborators(t *testing.T) {
	svc, _, media, _ := newSpecializedMem(func(deps *Dependencies, _ *memOwnedMedia, _ *drainRuntime) {
		deps.Catalog = nil
		deps.Secrets = nil
		deps.Media = nil
		deps.TextReplay = nil
	})
	media.put("user", readyVideo("res-1"))
	if _, err := svc.CreateTimelineRenderTask("user", TimelineRenderCreateRequest{Timeline: renderableTimeline("resource:res-1")}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateTimelineTranscriptionTask("user", TimelineTranscriptionCreateRequest{ResourceID: "res-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateDepthCaptureTask("user", DepthCaptureCreateRequest{ResourceID: "res-1"}); err != nil {
		t.Fatal(err)
	}
}

func TestSpecializedClientOperationReplayAndMismatch(t *testing.T) {
	svc, store, media, _ := newSpecializedMem(nil)
	media.put("user", readyVideo("res-1"))
	media.put("user", readyVideo("res-2"))
	first, err := svc.CreateTimelineTranscriptionTask("user", TimelineTranscriptionCreateRequest{
		ResourceID: "res-1", Language: "zh", ClientOperationID: "timeline:op-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	replay, err := svc.CreateTimelineTranscriptionTask("user", TimelineTranscriptionCreateRequest{
		ResourceID: "res-1", Language: "zh", ClientOperationID: "timeline:op-1",
	})
	if err != nil || replay.ID != first.ID {
		t.Fatalf("replay = %+v err=%v", replay, err)
	}
	_, err = svc.CreateTimelineTranscriptionTask("user", TimelineTranscriptionCreateRequest{
		ResourceID: "res-2", Language: "zh", ClientOperationID: "timeline:op-1",
	})
	if err == nil || !strings.Contains(err.Error(), "不同内容") || !isStatus(err, 409) {
		t.Fatalf("mismatch = %v", err)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 1 || listed[0].ID != first.ID {
		t.Fatalf("mismatch wrote rows: %+v", listed)
	}
}

func TestSpecializedReplayDuringDrainReturnsOriginal(t *testing.T) {
	svc, store, media, runtime := newSpecializedMem(nil)
	media.put("user", readyVideo("res-1"))
	created, err := svc.CreateTimelineRenderTask("user", TimelineRenderCreateRequest{
		Timeline: renderableTimeline("resource:res-1"), ClientOperationID: "timeline:drain-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime.draining.Store(true)
	replay, err := svc.CreateTimelineRenderTask("user", TimelineRenderCreateRequest{
		Timeline: renderableTimeline("resource:res-1"), ClientOperationID: "timeline:drain-1",
	})
	if err != nil || replay.ID != created.ID {
		t.Fatalf("drain replay = %+v err=%v", replay, err)
	}
	_, err = svc.CreateTimelineRenderTask("user", TimelineRenderCreateRequest{Timeline: renderableTimeline("resource:res-1")})
	if !isStatus(err, 503) || !strings.Contains(err.Error(), DrainCreateMessage) {
		t.Fatalf("drain create = %v", err)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 1 {
		t.Fatalf("drain wrote extra rows: %+v", listed)
	}
}

func TestSpecializedRejectsInactiveProjectWithoutInsert(t *testing.T) {
	svc, store, media, _ := newSpecializedMem(func(deps *Dependencies, _ *memOwnedMedia, _ *drainRuntime) {
		deps.Projects = scopeProjects{err: kernel.BadAuthRequest(TaskScopeUnavailableMessage)}
	})
	media.put("user", readyVideo("res-1"))
	_, err := svc.CreateDepthCaptureTask("user", DepthCaptureCreateRequest{ProjectID: "foreign", ResourceID: "res-1"})
	if err == nil || !strings.Contains(err.Error(), TaskScopeUnavailableMessage) {
		t.Fatalf("scope error = %v", err)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatalf("inactive project wrote rows: %+v", listed)
	}
}

func TestSpecializedValidationFailures(t *testing.T) {
	svc, store, media, _ := newSpecializedMem(nil)
	if _, err := svc.CreateTimelineTranscriptionTask("user", TimelineTranscriptionCreateRequest{}); err == nil || !strings.Contains(err.Error(), NeedTranscribableMediaMessage) {
		t.Fatalf("missing resource id = %v", err)
	}
	if _, err := svc.CreateTimelineTranscriptionTask("user", TimelineTranscriptionCreateRequest{ResourceID: "missing"}); err == nil || !strings.Contains(err.Error(), MissingTranscribableMediaMessage) {
		t.Fatalf("missing resource = %v", err)
	}
	media.put("user", model.Resource{ID: "res-img", MimeType: "image/png", Status: model.ResourceStatusReady})
	if _, err := svc.CreateTimelineTranscriptionTask("user", TimelineTranscriptionCreateRequest{ResourceID: "res-img"}); err == nil || !strings.Contains(err.Error(), OnlyAudioVideoTranscriptionMessage) {
		t.Fatalf("image transcription = %v", err)
	}
	if _, err := svc.CreateDepthCaptureTask("user", DepthCaptureCreateRequest{}); err == nil || !strings.Contains(err.Error(), depthcapture.ErrNeedVideo.Error()) {
		t.Fatalf("missing depth video = %v", err)
	}
	if _, err := svc.CreateDepthCaptureTask("user", DepthCaptureCreateRequest{ResourceID: "res-img"}); err == nil || !strings.Contains(err.Error(), depthcapture.ErrNotVideo.Error()) {
		t.Fatalf("image depth = %v", err)
	}
	textOnly := editing.Project{
		Version: 2, DurationMs: 1000,
		Tracks: []editing.Track{{ID: "t", Kind: "text"}},
		Clips:  []editing.Clip{{ID: "c", Kind: "text", TrackID: "t", DurationMs: 1000, Text: "字幕"}},
	}
	if _, err := svc.CreateTimelineRenderTask("user", TimelineRenderCreateRequest{Timeline: textOnly}); err == nil {
		t.Fatal("text-only timeline admitted")
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatalf("validation wrote rows: %+v", listed)
	}
}

func TestCloudTranscriptionAdmissionBindsModelAndPreservesOwner(t *testing.T) {
	calls := 0
	svc, _, media, _ := newSpecializedMem(func(deps *Dependencies, _ *memOwnedMedia, _ *drainRuntime) {
		deps.BindTranscriptionModel = func(model string) (string, error) {
			calls++
			if model != "hy-asr-3.0-preview" {
				return "", kernel.BadAuthRequest("unsupported transcription model")
			}
			return "token-fixture", nil
		}
	})
	media.put("owner", readyVideo("res-cloud"))
	req := TimelineTranscriptionCreateRequest{ResourceID: "res-cloud", Model: "hy-asr-3.0-preview", ClientOperationID: "cloud-op"}
	if _, err := svc.CreateTimelineTranscriptionTask("other", req); err == nil || calls != 0 {
		t.Fatalf("foreign media accepted: %v calls=%d", err, calls)
	}
	task, err := svc.CreateTimelineTranscriptionTask("owner", req)
	if err != nil {
		t.Fatal(err)
	}
	if task.Model != req.Model || task.Provider != "beefapi" || !strings.Contains(task.InputJSON, `"managedTokenId":"token-fixture"`) {
		t.Fatalf("bad task binding: %+v", task)
	}
	replay, err := svc.CreateTimelineTranscriptionTask("owner", req)
	if err != nil || replay.ID != task.ID {
		t.Fatalf("replay=%+v err=%v", replay, err)
	}
	req.Model = "speech-generation"
	if _, err := svc.CreateTimelineTranscriptionTask("owner", req); err == nil {
		t.Fatal("generation model accepted")
	}
}

func TestTranscriptionRequiresFeatureAndOwnedMedia(t *testing.T) {
	features := &captureFeatures{}
	svc, store, media, _ := newSpecializedMem(func(deps *Dependencies, _ *memOwnedMedia, _ *drainRuntime) {
		deps.Features = features
	})
	media.put("user", readyVideo("res-1"))
	if _, err := svc.CreateTimelineTranscriptionTask("user", TimelineTranscriptionCreateRequest{ResourceID: "res-1"}); err != nil {
		t.Fatal(err)
	}
	if features.name != TimelineTranscriptionFeature {
		t.Fatalf("feature = %q", features.name)
	}

	svc, store, _, _ = newSpecializedMem(func(deps *Dependencies, _ *memOwnedMedia, _ *drainRuntime) {
		deps.Features = nil
	})
	if _, err := svc.CreateTimelineTranscriptionTask("user", TimelineTranscriptionCreateRequest{ResourceID: "res-1"}); !isStatus(err, 500) {
		t.Fatalf("nil features = %v", err)
	}
	svc, store, _, _ = newSpecializedMem(func(deps *Dependencies, _ *memOwnedMedia, _ *drainRuntime) {
		deps.OwnedMedia = nil
	})
	if _, err := svc.CreateTimelineTranscriptionTask("user", TimelineTranscriptionCreateRequest{ResourceID: "res-1"}); !isStatus(err, 500) {
		t.Fatalf("nil owned media = %v", err)
	}
	svc, store, _, _ = newSpecializedMem(func(deps *Dependencies, _ *memOwnedMedia, _ *drainRuntime) {
		deps.Features = denyFeatures{err: kernel.Forbidden("字幕转写暂未开放")}
	})
	if _, err := svc.CreateTimelineTranscriptionTask("user", TimelineTranscriptionCreateRequest{ResourceID: "res-1"}); err == nil || !strings.Contains(err.Error(), "暂未开放") {
		t.Fatalf("disabled feature = %v", err)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatalf("fail-closed wrote rows: %+v", listed)
	}
}

func TestDepthRequiresOwnedMedia(t *testing.T) {
	svc, store, _, _ := newSpecializedMem(func(deps *Dependencies, _ *memOwnedMedia, _ *drainRuntime) {
		deps.OwnedMedia = nil
	})
	if _, err := svc.CreateDepthCaptureTask("user", DepthCaptureCreateRequest{ResourceID: "res-1"}); !isStatus(err, 500) {
		t.Fatalf("nil owned media = %v", err)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatalf("nil owned media wrote rows: %+v", listed)
	}
}

func mustTask(t *testing.T, store *memStore, id string) model.Task {
	t.Helper()
	task, err := store.TaskForUser("user", id)
	if err != nil {
		t.Fatal(err)
	}
	return *task
}
