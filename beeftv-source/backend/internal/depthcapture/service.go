package depthcapture

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"sync"

	"infinite-canvas/backend/internal/depthruntime"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
)

// Service owns depth capture execution. Create-time quota and activity stay
// in the application composition layer.
type Service struct {
	probeOutput          func(context.Context, string) (mediatools.MediaMetadata, error)
	dataDir              string
	media                Media
	tasks                Tasks
	installer            Installer
	windowsKey           string
	goos                 string
	goarch               string
	nvidia               NVIDIACheck
	cudaProbe            CUDAProbe
	run                  CommandRun
	getenv               func(string) string
	stat                 func(name string) error
	mkdirTemp            func(dir, pattern string) (string, error)
	configure            func(*exec.Cmd)
	componentMu          sync.Mutex
	componentState       ComponentState
	componentCancel      context.CancelFunc
	componentDone        chan struct{}
	componentClosed      bool
	componentFallbackCPU bool
}

func New(deps Deps) *Service {
	goos := deps.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	goarch := deps.GOARCH
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	getenv := deps.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	stat := deps.Stat
	if stat == nil {
		stat = func(name string) error {
			_, err := os.Stat(name)
			return err
		}
	}
	mkdirTemp := deps.MkdirTemp
	if mkdirTemp == nil {
		mkdirTemp = os.MkdirTemp
	}
	configure := deps.Configure
	if configure == nil {
		configure = configureDepthCommand
	}
	nvidia := deps.NVIDIA
	if nvidia == nil {
		nvidia = func(ctx context.Context) bool {
			return hasNVIDIACandidate(ctx, goos)
		}
	}
	cudaProbe := deps.ProbeCUDA
	if cudaProbe == nil {
		cudaProbe = func(ctx context.Context, python, toolDir, modelRuntime string) error {
			return probeCUDA(ctx, python, toolDir, modelRuntime, goos, configure)
		}
	}
	run := deps.Run
	if run == nil {
		run = func(ctx context.Context, python, toolDir, modelRuntime, device, inputPath, outputDir string, onLine func(string)) error {
			return runCommand(ctx, python, toolDir, modelRuntime, device, inputPath, outputDir, goos, onLine, configure)
		}
	}
	s := &Service{
		probeOutput: deps.ProbeOutput,
		dataDir:     deps.DataDir,
		media:       deps.Media,
		tasks:       deps.Tasks,
		installer:   deps.Installer,
		windowsKey:  deps.WindowsManifestPublicKeyBase64,
		goos:        goos,
		goarch:      goarch,
		nvidia:      nvidia,
		cudaProbe:   cudaProbe,
		run:         run,
		getenv:      getenv,
		stat:        stat,
		mkdirTemp:   mkdirTemp,
		configure:   configure,
	}
	if s.probeOutput == nil {
		s.probeOutput = mediatools.ProbeLocal
	}
	return s
}

func (s *Service) ensure(ctx context.Context, opts depthruntime.EnsureOptions) (depthruntime.Installation, error) {
	if s.installer != nil {
		return s.installer.Ensure(ctx, opts)
	}
	return depthruntime.Ensure(ctx, opts)
}

func (s *Service) progress(task *model.Task, stage string, percent int) error {
	if s.tasks == nil {
		return nil
	}
	return s.tasks.Progress(task, stage, percent)
}

func (s *Service) fail(task *model.Task, stage, message string) error {
	if s.tasks == nil {
		return nil
	}
	return s.tasks.Fail(task, stage, message)
}

func (s *Service) failUnlessCanceled(ctx context.Context, task *model.Task, stage, message string) error {
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	return s.fail(task, stage, message)
}
