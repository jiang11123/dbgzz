package depthcapture

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/depthruntime"
	"infinite-canvas/backend/internal/model"
)

func TestComponentManifestMirrorsRespectExplicitOverride(t *testing.T) {
	for _, platform := range []string{"darwin-arm64", "windows-amd64"} {
		for _, override := range []string{"", "https://custom.invalid/manifest"} {
			svc := New(Deps{DataDir: t.TempDir(), WindowsManifestPublicKeyBase64: base64.StdEncoding.EncodeToString(make([]byte, 32)), Getenv: func(key string) string {
				if key == manifestEnv {
					return override
				}
				return ""
			}})
			options, err := svc.componentOptions(platform, "cpu")
			if err != nil {
				t.Fatal(err)
			}
			if override != "" {
				if options.ManifestURL != override || len(options.ManifestMirrors) != 0 {
					t.Fatalf("override leaked mirrors: %+v", options)
				}
				continue
			}
			name := "depth-runtime-manifest.json"
			if platform == "windows-amd64" {
				name = "depth-runtime-manifest.v2.json"
			}
			if options.ManifestURL != componentCOSBase+name || !reflect.DeepEqual(options.ManifestMirrors, []string{componentR2Base + name, componentGHBase + name}) {
				t.Fatalf("default sources: %+v", options)
			}
		}
	}
}

func TestCaptureDoesNotDownloadMissingComponents(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1); http.Error(w, "must not fetch", 500) }))
	defer server.Close()
	tasks := &fakeTasks{}
	svc := New(Deps{GOOS: "darwin", GOARCH: "arm64", DataDir: t.TempDir(), Media: &fakeMedia{resource: testVideo(), body: []byte("mp4")}, Tasks: tasks, Getenv: func(key string) string {
		if key == manifestEnv {
			return server.URL
		}
		return ""
	}})
	if err := svc.Process(context.Background(), &model.Task{ID: "depth", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`}); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 0 || !strings.Contains(tasks.failMsg, "设置") {
		t.Fatalf("implicit download: hits=%d failure=%s", hits.Load(), tasks.failMsg)
	}
}

type cancellableInstaller struct {
	started chan struct{}
	hits    atomic.Int32
}

func (i *cancellableInstaller) Ensure(ctx context.Context, _ depthruntime.EnsureOptions) (depthruntime.Installation, error) {
	i.hits.Add(1)
	close(i.started)
	<-ctx.Done()
	return depthruntime.Installation{}, ctx.Err()
}

func TestExplicitComponentDownloadIsSingleAndPausesWithoutRestarting(t *testing.T) {
	installer := &cancellableInstaller{started: make(chan struct{})}
	svc := New(Deps{GOOS: "darwin", GOARCH: "arm64", DataDir: t.TempDir(), Installer: installer})
	// State represents a completed metadata-only check before user confirmation.
	svc.componentState = ComponentState{Status: "not_installed", Variant: "mps", DataDir: svc.dataDir, DownloadBytes: 100, RequiredBytes: 200, FreeBytes: 1000}
	if installer.hits.Load() != 0 {
		t.Fatal("status started download")
	}
	if _, err := svc.StartComponentDownload(context.Background()); err != nil {
		t.Fatal(err)
	}
	<-installer.started
	if _, err := svc.StartComponentDownload(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := svc.PauseComponentDownload(ctx); err != nil {
		t.Fatal(err)
	}
	state, err := svc.ComponentStatus(ctx)
	if err != nil || state.Status != "paused" || installer.hits.Load() != 1 {
		t.Fatalf("state=%+v hits=%d err=%v", state, installer.hits.Load(), err)
	}
}

type committedInstaller struct{ started chan struct{} }

func (i committedInstaller) Ensure(ctx context.Context, _ depthruntime.EnsureOptions) (depthruntime.Installation, error) {
	close(i.started)
	<-ctx.Done()
	// Installation committed just before the cancellation was observed.
	return depthruntime.Installation{Python: "installed"}, nil
}

func TestCancellationDoesNotRelabelCommittedInstallation(t *testing.T) {
	installer := committedInstaller{started: make(chan struct{})}
	svc := New(Deps{GOOS: "darwin", GOARCH: "arm64", DataDir: t.TempDir(), Installer: installer})
	svc.componentState = ComponentState{Status: "not_installed", Variant: "mps", DataDir: svc.dataDir, DownloadBytes: 100, RequiredBytes: 200, FreeBytes: 1}
	state, err := svc.ComponentStatus(context.Background())
	if err != nil || state.FreeBytes <= 1 {
		t.Fatalf("space was not refreshed: %+v %v", state, err)
	}
	if _, err := svc.StartComponentDownload(context.Background()); err != nil {
		t.Fatal(err)
	}
	<-installer.started
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := svc.PauseComponentDownload(ctx); err != nil {
		t.Fatal(err)
	}
	state, err = svc.ComponentStatus(ctx)
	if err != nil || state.Status != "ready" || state.Error != "" {
		t.Fatalf("committed install misreported: %+v %v", state, err)
	}
}

func TestFailedConcurrentRefreshCannotEraseConfirmedDownloadPlan(t *testing.T) {
	installer := &cancellableInstaller{started: make(chan struct{})}
	var svc *Service
	var refresh atomic.Bool
	svc = New(Deps{GOOS: "darwin", GOARCH: "arm64", DataDir: t.TempDir(), Installer: installer, Getenv: func(key string) string {
		if key == manifestEnv && !refresh.Swap(true) {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			_, _ = svc.ComponentStatus(ctx, true)
		}
		return ""
	}})
	svc.componentState = ComponentState{Status: "not_installed", Variant: "mps", DataDir: svc.dataDir, DownloadBytes: 100, RequiredBytes: 200, FreeBytes: 1000}
	state, err := svc.StartComponentDownload(context.Background())
	if err != nil || state.DataDir != svc.dataDir || state.DownloadBytes != 100 || state.Variant != "mps" {
		t.Fatalf("lost confirmed plan: %+v %v", state, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := svc.PauseComponentDownload(ctx); err != nil {
		t.Fatal(err)
	}
}

type cudaOnlyInstaller struct{ t *testing.T }

func (i cudaOnlyInstaller) Ensure(_ context.Context, options depthruntime.EnsureOptions) (depthruntime.Installation, error) {
	if !options.Offline {
		i.t.Fatal("capture attempted an implicit download")
	}
	if options.Variant == "cpu" {
		return depthruntime.Installation{}, depthruntime.ErrNotInstalled
	}
	return depthruntime.Installation{Python: "python", ToolDir: "worker", ModelRuntime: "model"}, nil
}

func TestCUDAFallbackRequestsCPUConsentWithoutDownloading(t *testing.T) {
	tasks := &fakeTasks{}
	svc := New(Deps{GOOS: "windows", GOARCH: "amd64", DataDir: t.TempDir(), Media: &fakeMedia{resource: testVideo(), body: []byte("video")}, Tasks: tasks, Installer: cudaOnlyInstaller{t}, WindowsManifestPublicKeyBase64: base64.StdEncoding.EncodeToString(make([]byte, 32)), NVIDIA: func(context.Context) bool { return true }, ProbeCUDA: func(context.Context, string, string, string) error { return ErrCUDADevice }})
	svc.componentState = ComponentState{Status: "ready", Variant: "cuda"}
	if err := svc.Process(context.Background(), &model.Task{ID: "cuda-fallback", UserID: "user-1", InputJSON: `{"resourceId":"res-1"}`}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(tasks.failMsg, "CPU") || !svc.componentFallbackCPU || svc.componentState.Status != "" {
		t.Fatalf("CPU fallback lacks actionable consent: %s %+v", tasks.failMsg, svc.componentState)
	}
}
