package depthcapture

import (
	"context"
	"io"
	"os/exec"

	"infinite-canvas/backend/internal/depthruntime"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
)

const (
	StandardProfile = "vda-small-mps-standard-v1"
	Prompt          = "深度动作捕捉"
	InitialStage    = "检查深度处理组件"
	Provider        = "local"
	ModelID         = "video-depth-anything-small"
	MaxDurationMs   = int64(15_100)
	OutputName      = "depth-action-reference.mp4"

	pythonEnv   = "BEEFTV_DEPTH_PYTHON"
	toolDirEnv  = "BEEFTV_DEPTH_TOOL_DIR"
	runtimeEnv  = "BEEFTV_DEPTH_RUNTIME"
	manifestEnv = "BEEFTV_DEPTH_MANIFEST_URL"

	componentCOSBase          = "https://beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com/depth-runtime-v2/"
	componentR2Base           = "https://updates.beefapi.com/beeftv/components/depth-runtime-v2/"
	componentGHBase           = "https://github.com/glanderness/BeefTV/releases/download/depth-runtime-mirrors-v1/"
	defaultManifestURL        = componentCOSBase + "depth-runtime-manifest.json"
	defaultWindowsManifestURL = componentCOSBase + "depth-runtime-manifest.v2.json"
)

// CreateRequest is the HTTP create body. Handler keeps the app alias.
type CreateRequest struct {
	ProjectID  string `json:"projectId"`
	ResourceID string `json:"resourceId"`
}

type Input struct {
	ResourceID string `json:"resourceId"`
	Profile    string `json:"profile"`
}

type Result struct {
	ResourceID     string  `json:"resourceId"`
	FileName       string  `json:"fileName"`
	Size           int64   `json:"size"`
	DurationMs     int64   `json:"durationMs"`
	Width          int     `json:"width"`
	Height         int     `json:"height"`
	FPS            float64 `json:"fps,omitempty"`
	Device         string  `json:"device,omitempty"`
	FallbackReason string  `json:"fallbackReason,omitempty"`
	RuntimeVersion string  `json:"runtimeVersion,omitempty"`
	ProcessingMs   int64   `json:"processingMs,omitempty"`
}

type DeviceChoice struct {
	Variant        string
	Device         string
	FallbackReason string
}

type Installation struct {
	Python       string
	ToolDir      string
	ModelRuntime string
}

type Media interface {
	Open(userID, resourceID string) (*model.Resource, io.ReadCloser, error)
	SaveVideo(userID, fileName string, size int64, width, height int, durationMs int64, body io.ReadSeeker, sourceKey string) (*model.Resource, error)
}

type Tasks interface {
	Progress(task *model.Task, stage string, percent int) error
	Fail(task *model.Task, stage, message string) error
	Complete(task *model.Task, result Result) error
}

type Installer interface {
	Ensure(ctx context.Context, opts depthruntime.EnsureOptions) (depthruntime.Installation, error)
}

type NVIDIACheck func(ctx context.Context) bool

type CUDAProbe func(ctx context.Context, python, toolDir, modelRuntime string) error

type CommandRun func(ctx context.Context, python, toolDir, modelRuntime, device, inputPath, outputDir string, onLine func(string)) error

type Deps struct {
	ProbeOutput                    func(context.Context, string) (mediatools.MediaMetadata, error)
	DataDir                        string
	Media                          Media
	Tasks                          Tasks
	Installer                      Installer
	WindowsManifestPublicKeyBase64 string
	GOOS                           string
	GOARCH                         string
	NVIDIA                         NVIDIACheck
	ProbeCUDA                      CUDAProbe
	Run                            CommandRun
	Getenv                         func(key string) string
	Stat                           func(name string) error
	MkdirTemp                      func(dir, pattern string) (string, error)
	Configure                      func(*exec.Cmd)
}
