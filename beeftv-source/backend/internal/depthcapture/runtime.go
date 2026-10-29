package depthcapture

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/depthruntime"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) resolveRuntime(ctx context.Context, task *model.Task, platform, variant string) (python string, toolDir string, modelRuntime string, err error) {
	python = strings.TrimSpace(s.getenv(pythonEnv))
	toolDir = strings.TrimSpace(s.getenv(toolDirEnv))
	modelRuntime = strings.TrimSpace(s.getenv(runtimeEnv))
	if python != "" && toolDir != "" && modelRuntime != "" {
		if s.stat(python) == nil {
			return python, toolDir, modelRuntime, nil
		}
	}
	options, optionsErr := s.componentOptions(platform, variant)
	if optionsErr != nil {
		return "", "", "", optionsErr
	}
	options.Offline = true
	installation, ensureErr := s.ensure(ctx, options)
	if ensureErr != nil {
		if variant == "cpu" && ensureErr == depthruntime.ErrNotInstalled {
			return "", "", "", errors.New("当前需要 CPU 深度捕捉组件，请在存储设置中确认下载后重试")
		}
		return "", "", "", ensureErr
	}
	return installation.Python, installation.ToolDir, installation.ModelRuntime, nil
}

func (s *Service) componentOptions(platform, variant string) (depthruntime.EnsureOptions, error) {
	manifestURL := strings.TrimSpace(s.getenv(manifestEnv))
	var mirrors []string
	if manifestURL == "" {
		manifestURL = defaultManifestURL
		name := "depth-runtime-manifest.json"
		if platform == "windows-amd64" {
			manifestURL = defaultWindowsManifestURL
			name = "depth-runtime-manifest.v2.json"
		}
		mirrors = []string{componentR2Base + name, componentGHBase + name}
	}
	var publicKey ed25519.PublicKey
	var fallback *depthruntime.Manifest
	if platform == "windows-amd64" {
		decoded, err := base64.StdEncoding.DecodeString(s.windowsKey)
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			return depthruntime.EnsureOptions{}, ErrWindowsKey
		}
		publicKey = decoded
	} else {
		fallback = defaultFallbackManifest()
	}
	return depthruntime.EnsureOptions{
		ManifestURL:      manifestURL,
		ManifestMirrors:  mirrors,
		DataDir:          s.dataDir,
		Platform:         platform,
		Variant:          variant,
		TrustedPublicKey: publicKey,
		FallbackManifest: fallback,
	}, nil
}

func defaultFallbackManifest() *depthruntime.Manifest {
	return &depthruntime.Manifest{
		Version: 1,
		Runtime: depthruntime.Artifact{
			URLs:         componentSources("beeftv-depth-runtime-v1-darwin-arm64.zip", "https://github.com/glanderness/BeefTV/releases/download/v1.5.5/beeftv-depth-runtime-v1-darwin-arm64.zip"),
			Size:         294629974,
			SHA256:       "f606dee084ec9d38d76a80e409e4cb9a80ad7db51c18778285a63e8f24376682",
			Files:        23_481,
			ExpandedSize: 955_790_953,
		},
		Model: depthruntime.Artifact{
			URLs:   append(componentSources("video_depth_anything_vits.pth", "https://github.com/glanderness/BeefTV/releases/download/v1.5.5/video_depth_anything_vits.pth"), "https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/main/video_depth_anything_vits.pth"),
			Size:   116440756,
			SHA256: "13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609",
		},
	}
}

func componentSources(name, original string) []string {
	return []string{componentCOSBase + name, componentR2Base + name, original}
}
