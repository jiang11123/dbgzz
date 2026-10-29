package depthcapture

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"infinite-canvas/backend/internal/desktopnet"
	"infinite-canvas/backend/internal/mediatools"
)

func WorkerEnv(toolDir string) []string {
	return WorkerEnvForPlatform(toolDir, runtime.GOOS)
}

func WorkerEnvForPlatform(toolDir, platform string) []string {
	env := workerEnv(toolDir, platform, os.Environ(), os.Getenv)
	// Published Python workers invoke ffprobe/ffmpeg by name. Finder's PATH
	// does not contain the signed tools bundled beside the desktop executable.
	var mediaDirs []string
	for _, resolve := range []func() (string, error){mediatools.ResolveFFprobe, mediatools.ResolveFFmpeg} {
		if path, err := resolve(); err == nil {
			mediaDirs = append(mediaDirs, filepath.Dir(path))
		}
	}
	if len(mediaDirs) > 0 {
		var inheritedPath string
		filtered := make([]string, 0, len(env))
		for _, entry := range env {
			if strings.HasPrefix(entry, "PATH=") {
				inheritedPath = strings.TrimPrefix(entry, "PATH=")
			} else {
				filtered = append(filtered, entry)
			}
		}
		mediaDirs = append(mediaDirs, inheritedPath)
		env = append(filtered, "PATH="+strings.Join(mediaDirs, string(os.PathListSeparator)))
	}
	// Published workers may repair a missing checkpoint with curl. Use the
	// same freshly resolved proxy as the signed component downloader.
	return append(env, desktopnet.HTTPSProxyEnvironment()...)
}

func workerEnv(toolDir, platform string, environ []string, getenv func(string) string) []string {
	if getenv == nil {
		getenv = os.Getenv
	}
	env := append(append([]string{}, environ...), "PYTORCH_ENABLE_MPS_FALLBACK=1", "BEEFTV_VDA_SOURCE="+filepath.Join(filepath.Dir(toolDir), "vda"))
	if platform == "windows" {
		env = append(env, "PYTHONIOENCODING=utf-8", "PATH="+filepath.Join(filepath.Dir(toolDir), "bin")+string(os.PathListSeparator)+getenv("PATH"))
	}
	return env
}
