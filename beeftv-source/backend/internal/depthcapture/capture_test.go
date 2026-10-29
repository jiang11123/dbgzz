package depthcapture

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/depthruntime"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
)

type fakeMedia struct {
	resource *model.Resource
	body     []byte
	saved    *model.Resource
	saveErr  error
}

func (m *fakeMedia) Open(userID, resourceID string) (*model.Resource, io.ReadCloser, error) {
	if m.resource == nil || m.resource.UserID != userID || m.resource.ID != resourceID {
		return nil, nil, errors.New("missing")
	}
	return m.resource, io.NopCloser(bytes.NewReader(m.body)), nil
}

func (m *fakeMedia) SaveVideo(userID, fileName string, size int64, width, height int, durationMs int64, body io.ReadSeeker, sourceKey string) (*model.Resource, error) {
	if m.saveErr != nil {
		return nil, m.saveErr
	}
	m.saved = &model.Resource{ID: "out-1", UserID: userID, Size: size, Width: width, Height: height, DurationMs: durationMs}
	return m.saved, nil
}

type fakeTasks struct {
	stages    []string
	failStage string
	failMsg   string
	result    *Result
}

func (t *fakeTasks) Progress(task *model.Task, stage string, percent int) error {
	t.stages = append(t.stages, stage)
	return nil
}

func (t *fakeTasks) Fail(task *model.Task, stage, message string) error {
	t.failStage = stage
	t.failMsg = message
	return nil
}

func (t *fakeTasks) Complete(task *model.Task, result Result) error {
	copy := result
	t.result = &copy
	return nil
}

type fakeInstaller struct{}

func (fakeInstaller) Ensure(ctx context.Context, opts depthruntime.EnsureOptions) (depthruntime.Installation, error) {
	return depthruntime.Installation{Python: "python", ToolDir: "tools", ModelRuntime: "runtime"}, nil
}

func testVideo() *model.Resource {
	return &model.Resource{
		ID: "res-1", UserID: "user-1", Kind: "video", MimeType: "video/mp4",
		Status: model.ResourceStatusReady, DurationMs: 3000,
	}
}

func TestProcessRetainsWorkerExitReasonAfterLongProgressMeter(t *testing.T) {
	tasks := &fakeTasks{}
	message := strings.Repeat("\r 0 0 0 0 Time Time Current", 150) + "\ncurl: (28) Connection timed out\n模型补下载失败"
	svc := New(Deps{
		GOOS: "darwin", GOARCH: "arm64", Media: &fakeMedia{resource: testVideo(), body: []byte("mp4")}, Tasks: tasks, Installer: fakeInstaller{},
		Run: func(context.Context, string, string, string, string, string, string, func(string)) error {
			return errors.New(message)
		},
	})
	if err := svc.Process(context.Background(), &model.Task{ID: "t1", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`}); err != nil {
		t.Fatal(err)
	}
	if tasks.failStage != stageFailed || !strings.Contains(tasks.failMsg, "curl: (28)") || !strings.HasSuffix(tasks.failMsg, "模型补下载失败") || len([]rune(tasks.failMsg)) > 801 {
		t.Fatalf("failure summary = %q", tasks.failMsg)
	}
}

func TestProcessRejectsUnsupportedPlatform(t *testing.T) {
	tasks := &fakeTasks{}
	svc := New(Deps{
		GOOS: "linux", GOARCH: "amd64",
		Media: &fakeMedia{resource: testVideo(), body: []byte("mp4")},
		Tasks: tasks,
	})
	err := svc.Process(context.Background(), &model.Task{ID: "t1", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`})
	if err != nil {
		t.Fatal(err)
	}
	if tasks.failStage != stageUnavailable || !strings.Contains(tasks.failMsg, "Apple Silicon") {
		t.Fatalf("fail = %s %s", tasks.failStage, tasks.failMsg)
	}
}

func TestProcessRejectsLongVideo(t *testing.T) {
	resource := testVideo()
	resource.DurationMs = 16_000
	tasks := &fakeTasks{}
	svc := New(Deps{
		GOOS: "darwin", GOARCH: "arm64",
		Media:     &fakeMedia{resource: resource, body: []byte("mp4")},
		Tasks:     tasks,
		Installer: fakeInstaller{},
	})
	if err := svc.Process(context.Background(), &model.Task{ID: "t1", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`}); err != nil {
		t.Fatal(err)
	}
	if tasks.failStage != stageTooLong {
		t.Fatalf("stage = %s msg=%s", tasks.failStage, tasks.failMsg)
	}
}

func TestProcessRejectsNonVideo(t *testing.T) {
	resource := testVideo()
	resource.MimeType = "image/png"
	tasks := &fakeTasks{}
	svc := New(Deps{
		GOOS: "darwin", GOARCH: "arm64",
		Media: &fakeMedia{resource: resource, body: []byte("png")},
		Tasks: tasks,
	})
	if err := svc.Process(context.Background(), &model.Task{ID: "t1", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`}); err != nil {
		t.Fatal(err)
	}
	if tasks.failStage != stageFailed || tasks.failMsg != ErrNotVideo.Error() {
		t.Fatalf("fail = %s %s", tasks.failStage, tasks.failMsg)
	}
}

func TestProcessSavesSinglePreview(t *testing.T) {
	tasks := &fakeTasks{}
	media := &fakeMedia{resource: testVideo(), body: []byte("mp4-bytes")}
	svc := New(Deps{
		ProbeOutput: func(context.Context, string) (mediatools.MediaMetadata, error) {
			return mediatools.MediaMetadata{HasVideo: true, Width: 1080, Height: 1920, DurationMs: 2967}, nil
		},
		GOOS: "darwin", GOARCH: "arm64",
		Media:     media,
		Tasks:     tasks,
		Installer: fakeInstaller{},
		Stat:      func(string) error { return nil },
		Getenv: func(key string) string {
			switch key {
			case pythonEnv, toolDirEnv, runtimeEnv:
				return "override"
			default:
				return ""
			}
		},
		Run: func(ctx context.Context, python, toolDir, modelRuntime, device, inputPath, outputDir string, onLine func(string)) error {
			if device != "mps" {
				t.Fatalf("device = %s", device)
			}
			onLine("[2/3] analyze")
			onLine("[3/3] encode")
			preview := filepath.Join(outputDir, "clip_depth_preview.mp4")
			if err := os.WriteFile(preview, []byte("preview"), 0o600); err != nil {
				return err
			}
			return nil
		},
	})
	task := &model.Task{ID: "t1", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`}
	if err := svc.Process(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	if tasks.result == nil || tasks.result.ResourceID != "out-1" || tasks.result.Device != "mps" {
		t.Fatalf("result = %+v", tasks.result)
	}
	if media.saved == nil || media.saved.Width != 1080 || media.saved.Height != 1920 || media.saved.DurationMs != 2967 || tasks.result.Width != 1080 || tasks.result.Height != 1920 {
		t.Fatalf("saved = %+v", media.saved)
	}
	joined := strings.Join(tasks.stages, ",")
	if !strings.Contains(joined, "分析视频") || !strings.Contains(joined, "生成结果视频") {
		t.Fatalf("progress = %v", tasks.stages)
	}
}

func TestProcessFallsBackOnceFromCUDADeviceFailure(t *testing.T) {
	tasks := &fakeTasks{}
	runs := 0
	svc := New(Deps{
		ProbeOutput: func(context.Context, string) (mediatools.MediaMetadata, error) {
			return mediatools.MediaMetadata{HasVideo: true, Width: 1920, Height: 1080, DurationMs: 3000}, nil
		},
		GOOS: "windows", GOARCH: "amd64",
		Media:     &fakeMedia{resource: testVideo(), body: []byte("mp4")},
		Tasks:     tasks,
		Installer: fakeInstaller{},
		NVIDIA:    func(context.Context) bool { return true },
		ProbeCUDA: func(context.Context, string, string, string) error { return nil },
		Stat:      func(string) error { return nil },
		Getenv: func(key string) string {
			switch key {
			case pythonEnv, toolDirEnv, runtimeEnv:
				return "override"
			default:
				return ""
			}
		},
		Run: func(ctx context.Context, python, toolDir, modelRuntime, device, inputPath, outputDir string, onLine func(string)) error {
			runs++
			if runs == 1 {
				if device != "cuda" {
					t.Fatalf("first device = %s", device)
				}
				return ErrCUDADevice
			}
			if device != "cpu" {
				t.Fatalf("retry device = %s", device)
			}
			return os.WriteFile(filepath.Join(outputDir, "clip_depth_preview.mp4"), []byte("preview"), 0o600)
		},
	})
	if err := svc.Process(context.Background(), &model.Task{ID: "t1", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`}); err != nil {
		t.Fatal(err)
	}
	if runs != 2 {
		t.Fatalf("runs = %d", runs)
	}
	if tasks.result == nil || tasks.result.Device != "cpu" || tasks.result.FallbackReason == "" {
		t.Fatalf("result = %+v", tasks.result)
	}
}

func TestProcessRejectsMissingPreview(t *testing.T) {
	tasks := &fakeTasks{}
	svc := New(Deps{
		GOOS: "darwin", GOARCH: "arm64",
		Media:     &fakeMedia{resource: testVideo(), body: []byte("mp4")},
		Tasks:     tasks,
		Installer: fakeInstaller{},
		Stat:      func(string) error { return nil },
		Getenv: func(key string) string {
			switch key {
			case pythonEnv, toolDirEnv, runtimeEnv:
				return "override"
			default:
				return ""
			}
		},
		Run: func(ctx context.Context, python, toolDir, modelRuntime, device, inputPath, outputDir string, onLine func(string)) error {
			return nil
		},
	})
	if err := svc.Process(context.Background(), &model.Task{ID: "t1", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`}); err != nil {
		t.Fatal(err)
	}
	if tasks.failStage != stageOutput {
		t.Fatalf("stage = %s", tasks.failStage)
	}
}

func TestPrepareInput(t *testing.T) {
	if _, err := PrepareInput("", testVideo()); !errors.Is(err, ErrNeedVideo) {
		t.Fatalf("empty id: %v", err)
	}
	if _, err := PrepareInput("res-1", nil); !errors.Is(err, ErrMissingVideo) {
		t.Fatalf("missing: %v", err)
	}
	image := testVideo()
	image.MimeType = "image/png"
	if _, err := PrepareInput("res-1", image); !errors.Is(err, ErrNotVideo) {
		t.Fatalf("image: %v", err)
	}
	raw, err := PrepareInput("res-1", testVideo())
	if err != nil {
		t.Fatal(err)
	}
	input, err := ParseInput(string(raw))
	if err != nil || input.Profile != StandardProfile || input.ResourceID != "res-1" {
		t.Fatalf("input = %+v err=%v", input, err)
	}
}

func TestOverDurationBoundary(t *testing.T) {
	if OverDuration(15_100) {
		t.Fatal("15.1s must still be accepted")
	}
	if !OverDuration(15_101) {
		t.Fatal("15.101s must be rejected")
	}
}

func TestWindowsRuntimeRequiresPublicKey(t *testing.T) {
	tasks := &fakeTasks{}
	svc := New(Deps{
		GOOS:      "windows",
		GOARCH:    "amd64",
		Media:     &fakeMedia{resource: testVideo(), body: []byte("mp4")},
		Tasks:     tasks,
		Installer: fakeInstaller{},
		NVIDIA:    func(context.Context) bool { return false },
	})
	if err := svc.Process(context.Background(), &model.Task{ID: "t1", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`}); err != nil {
		t.Fatal(err)
	}
	if tasks.failStage != stageComponent || tasks.failMsg != ErrWindowsKey.Error() {
		t.Fatalf("fail = %s %s", tasks.failStage, tasks.failMsg)
	}
}

func TestProcessHonorsCancelDuringRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	tasks := &fakeTasks{}
	svc := New(Deps{
		GOOS: "darwin", GOARCH: "arm64",
		Media:     &fakeMedia{resource: testVideo(), body: []byte("mp4")},
		Tasks:     tasks,
		Installer: fakeInstaller{},
		Stat:      func(string) error { return nil },
		Getenv: func(key string) string {
			switch key {
			case pythonEnv, toolDirEnv, runtimeEnv:
				return "override"
			default:
				return ""
			}
		},
		Run: func(runCtx context.Context, python, toolDir, modelRuntime, device, inputPath, outputDir string, onLine func(string)) error {
			cancel()
			return context.Canceled
		},
	})
	err := svc.Process(ctx, &model.Task{ID: "t1", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if tasks.failStage != "" {
		t.Fatalf("canceled run wrote fail stage %s", tasks.failStage)
	}
}

func TestProcessCancelDoesNotRetryCUDA(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	runs := 0
	svc := New(Deps{
		GOOS: "windows", GOARCH: "amd64",
		Media:     &fakeMedia{resource: testVideo(), body: []byte("mp4")},
		Tasks:     &fakeTasks{},
		Installer: fakeInstaller{},
		NVIDIA:    func(context.Context) bool { return true },
		ProbeCUDA: func(context.Context, string, string, string) error { return nil },
		Stat:      func(string) error { return nil },
		Getenv: func(key string) string {
			switch key {
			case pythonEnv, toolDirEnv, runtimeEnv:
				return "override"
			default:
				return ""
			}
		},
		Run: func(runCtx context.Context, python, toolDir, modelRuntime, device, inputPath, outputDir string, onLine func(string)) error {
			runs++
			return ErrCUDADevice
		},
	})
	_ = svc.Process(ctx, &model.Task{ID: "t1", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`})
	if runs > 1 {
		t.Fatalf("canceled CUDA retried, runs=%d", runs)
	}
}

func TestProcessCancelAfterOutputSkipsComplete(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	tasks := &fakeTasks{}
	media := &fakeMedia{resource: testVideo(), body: []byte("mp4")}
	svc := New(Deps{
		GOOS: "darwin", GOARCH: "arm64",
		Media:     media,
		Tasks:     tasks,
		Installer: fakeInstaller{},
		Stat:      func(string) error { return nil },
		Getenv: func(key string) string {
			switch key {
			case pythonEnv, toolDirEnv, runtimeEnv:
				return "override"
			default:
				return ""
			}
		},
		Run: func(runCtx context.Context, python, toolDir, modelRuntime, device, inputPath, outputDir string, onLine func(string)) error {
			if err := os.WriteFile(filepath.Join(outputDir, "clip_depth_preview.mp4"), []byte("preview"), 0o600); err != nil {
				return err
			}
			cancel()
			return nil
		},
	})
	err := svc.Process(ctx, &model.Task{ID: "t1", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if tasks.result != nil {
		t.Fatal("canceled process completed the task")
	}
	if tasks.failStage != "" {
		t.Fatalf("canceled process failed the task: %s", tasks.failStage)
	}
	if media.saved != nil {
		t.Fatal("canceled process saved a new video")
	}
}

func TestProcessCancelDuringDeviceProbeDoesNotFailTask(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	tasks := &fakeTasks{}
	svc := New(Deps{
		GOOS: "windows", GOARCH: "amd64",
		Media:     &fakeMedia{resource: testVideo(), body: []byte("mp4")},
		Tasks:     tasks,
		Installer: fakeInstaller{},
		NVIDIA:    func(context.Context) bool { return true },
		ProbeCUDA: func(context.Context, string, string, string) error {
			cancel()
			return context.Canceled
		},
		Stat: func(string) error { return nil },
		Getenv: func(key string) string {
			switch key {
			case pythonEnv, toolDirEnv, runtimeEnv:
				return "override"
			default:
				return ""
			}
		},
	})
	err := svc.Process(ctx, &model.Task{ID: "t1", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if tasks.failStage != "" {
		t.Fatalf("canceled probe wrote fail stage %s", tasks.failStage)
	}
}
