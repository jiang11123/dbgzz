package depthcapture

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkerFindsBundledMediaToolsWithoutShellPath(t *testing.T) {
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("CANVAS_FFPROBE_PATH", "/Applications/BeefTV.app/Contents/Resources/agent-host/media-runtime/ffprobe")
	t.Setenv("CANVAS_FFMPEG_PATH", "/Applications/BeefTV.app/Contents/Resources/agent-host/media-runtime/ffmpeg")
	for _, platform := range []string{"darwin", "windows"} {
		env := WorkerEnvForPlatform("/depth/worker", platform)
		count := 0
		for _, entry := range env {
			if !strings.HasPrefix(entry, "PATH=") {
				continue
			}
			count++
			path := strings.TrimPrefix(entry, "PATH=")
			if !strings.HasPrefix(path, filepath.Dir(os.Getenv("CANVAS_FFPROBE_PATH"))+string(os.PathListSeparator)) || !strings.HasSuffix(path, "/usr/bin:/bin") {
				t.Fatalf("%s media PATH = %q", platform, path)
			}
			if platform == "windows" && !strings.Contains(path, filepath.Join("/depth", "bin")) {
				t.Fatalf("Windows component tools lost: %q", path)
			}
		}
		if count != 1 {
			t.Fatalf("%s has %d PATH entries", platform, count)
		}
	}
}

func TestWindowsWorkerUsesUTF8ForChineseProgress(t *testing.T) {
	env := WorkerEnvForPlatform("C:/depth/worker", "windows")
	if !strings.Contains(strings.Join(env, "\n"), "PYTHONIOENCODING=utf-8") {
		t.Fatal("Windows worker does not force UTF-8 for its progress output")
	}
}

func TestWorkerCheckpointDownloadUsesResolvedDesktopProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:7890")
	t.Setenv("https_proxy", "http://127.0.0.1:9999")
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")
	env := WorkerEnvForPlatform("C:/depth/worker", "windows")
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "HTTPS_PROXY=http://127.0.0.1:7890\nhttps_proxy=http://127.0.0.1:7890\nNO_PROXY=") {
		t.Fatal("worker curl does not share the component downloader's proxy selection")
	}
	t.Setenv("ALL_PROXY", "http://127.0.0.1:8888")
	t.Setenv("NO_PROXY", "cdn.example.com")
	command := exec.Command(os.Args[0], "-test.run=^TestDepthProxyChildProcess$")
	command.Env = append(WorkerEnvForPlatform("C:/depth/worker", "windows"), "BEEFTV_PROXY_TEST_HELPER=1")
	output, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	var actual map[string]string
	if err := json.Unmarshal(output, &actual); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"HTTPS_PROXY", "https_proxy"} {
		if actual[key] != "http://127.0.0.1:7890" {
			t.Fatalf("child %s = %q", key, actual[key])
		}
	}
	if actual["NO_PROXY"] != "cdn.example.com" || actual["no_proxy"] != "cdn.example.com" || actual["ALL_PROXY"] != "" || actual["all_proxy"] != "" {
		t.Fatalf("child proxy exclusions = %+v", actual)
	}
}

func TestDepthProxyChildProcess(t *testing.T) {
	if os.Getenv("BEEFTV_PROXY_TEST_HELPER") != "1" {
		return
	}
	actual := map[string]string{}
	for _, key := range []string{"HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"} {
		actual[key] = os.Getenv(key)
	}
	_ = json.NewEncoder(os.Stdout).Encode(actual)
	os.Exit(0)
}

func TestChooseDeviceKeepsMacMPSAndSkipsWindowsCUDAWithoutCandidate(t *testing.T) {
	probed := false
	mac, err := ChooseDevice(context.Background(), "darwin", "arm64", false, func(context.Context) error { probed = true; return nil })
	if err != nil || mac.Variant != "mps" || mac.Device != "mps" || probed {
		t.Fatalf("Mac choice=%+v err=%v probed=%v", mac, err, probed)
	}
	windows, err := ChooseDevice(context.Background(), "windows", "amd64", false, func(context.Context) error { probed = true; return nil })
	if err != nil || windows.Variant != "cpu" || windows.Device != "cpu" || probed {
		t.Fatalf("Windows choice=%+v err=%v probed=%v", windows, err, probed)
	}
}

func TestChooseDeviceRequiresRealCUDAProbe(t *testing.T) {
	called := 0
	choice, err := ChooseDevice(context.Background(), "windows", "amd64", true, func(context.Context) error { called++; return nil })
	if err != nil || choice.Device != "cuda" || called != 1 {
		t.Fatalf("choice=%+v err=%v called=%d", choice, err, called)
	}
	choice, err = ChooseDevice(context.Background(), "windows", "amd64", true, func(context.Context) error { return ErrCUDADevice })
	if err != nil || choice.Device != "cpu" || choice.FallbackReason == "" {
		t.Fatalf("choice=%+v err=%v", choice, err)
	}
	_, err = ChooseDevice(context.Background(), "windows", "amd64", true, func(context.Context) error { return errors.New("checksum mismatch") })
	if err == nil {
		t.Fatal("non-device CUDA preparation error was hidden by CPU fallback")
	}
}

func TestCPUFallbackOnlyForOneUncancelledCUDADeviceFailure(t *testing.T) {
	if !ShouldRetryOnCPU(ErrCUDADevice, nil, 0) {
		t.Fatal("device failure should allow one retry")
	}
	if ShouldRetryOnCPU(ErrCUDADevice, nil, 1) {
		t.Fatal("second retry allowed")
	}
	if ShouldRetryOnCPU(ErrCUDADevice, context.Canceled, 0) {
		t.Fatal("canceled task retried")
	}
	if ShouldRetryOnCPU(errors.New("bad input"), nil, 0) {
		t.Fatal("non-device error retried")
	}
}

func TestWorkerExitCodeIsStableFallbackSignal(t *testing.T) {
	if !errors.Is(ClassifyWorkerExit(42, "CUDA error"), ErrCUDADevice) {
		t.Fatal("CUDA exit code did not classify as a device failure")
	}
	if errors.Is(ClassifyWorkerExit(1, "CUDA error text in a non-device failure"), ErrCUDADevice) {
		t.Fatal("free-form stderr triggered a device fallback")
	}
}

func TestSupportedPlatform(t *testing.T) {
	if !Supported("darwin", "arm64") || !Supported("windows", "amd64") {
		t.Fatal("supported platforms rejected")
	}
	if Supported("linux", "amd64") || Supported("darwin", "amd64") {
		t.Fatal("unsupported platform accepted")
	}
}
