package depthcapture

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

func hasNVIDIACandidate(ctx context.Context, goos string) bool {
	if goos != "windows" {
		return false
	}
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	command := exec.CommandContext(probeCtx, "nvidia-smi", "-L")
	configureDepthCommand(command)
	output, err := command.Output()
	return err == nil && strings.TrimSpace(string(output)) != ""
}

func probeCUDA(ctx context.Context, python, toolDir, modelRuntime, goos string, configure func(*exec.Cmd)) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	workDir, err := os.MkdirTemp("", "beeftv-depth-cuda-probe-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workDir)
	command := exec.CommandContext(ctx, python, "-m", "depth_capture.probe", "--device", "cuda", "--runtime-dir", modelRuntime, "--work-dir", workDir)
	command.Dir = toolDir
	command.Env = WorkerEnvForPlatform(toolDir, goos)
	if configure != nil {
		configure(command)
	} else {
		configureDepthCommand(command)
	}
	output, err := command.CombinedOutput()
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fmt.Errorf("CUDA 真实模型探针失败: %w", ClassifyWorkerExit(exit.ExitCode(), strings.TrimSpace(string(output))))
	}
	return fmt.Errorf("无法运行 CUDA 真实模型探针: %w", err)
}

func runCommand(ctx context.Context, python, toolDir, modelRuntime, device, inputPath, outputDir, goos string, onLine func(string), configure func(*exec.Cmd)) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	command := exec.CommandContext(ctx, python, "-m", "depth_capture", inputPath,
		"--output-dir", outputDir, "--runtime-dir", modelRuntime, "--device", device,
		"--input-size", "280", "--max-resolution", "960", "--output-resolution", "source",
		"--max-seconds", "15", "--low-percentile", "2", "--high-percentile", "98", "--gamma", "1.25")
	command.Dir = toolDir
	command.Env = WorkerEnvForPlatform(toolDir, goos)
	if configure != nil {
		configure(command)
	} else {
		configureDepthCommand(command)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return fmt.Errorf("无法启动深度处理组件: %w", err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		return fmt.Errorf("无法启动深度处理组件: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		if onLine != nil {
			onLine(line)
		}
	}
	scanErr := scanner.Err()
	runErr := command.Wait()
	if scanErr != nil && runErr == nil {
		return scanErr
	}
	if runErr != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = runErr.Error()
		}
		var exit *exec.ExitError
		if errors.As(runErr, &exit) && device == "cuda" {
			return ClassifyWorkerExit(exit.ExitCode(), message)
		}
		return errors.New(message)
	}
	return nil
}
