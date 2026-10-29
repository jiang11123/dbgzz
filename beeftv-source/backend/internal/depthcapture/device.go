package depthcapture

import (
	"context"
	"errors"
	"fmt"
)

func ChooseDevice(ctx context.Context, goos, goarch string, cudaCandidate bool, tryCUDA func(context.Context) error) (DeviceChoice, error) {
	if goos == "darwin" && goarch == "arm64" {
		return DeviceChoice{Variant: "mps", Device: "mps"}, nil
	}
	if goos != "windows" || goarch != "amd64" {
		return DeviceChoice{}, fmt.Errorf("深度处理暂不支持 %s/%s", goos, goarch)
	}
	if err := ctx.Err(); err != nil {
		return DeviceChoice{}, err
	}
	if !cudaCandidate {
		return DeviceChoice{Variant: "cpu", Device: "cpu", FallbackReason: "未检测到可用的 NVIDIA CUDA 设备"}, nil
	}
	if tryCUDA == nil {
		return DeviceChoice{}, ErrMissingCUDA
	}
	if err := tryCUDA(ctx); err != nil {
		if ctx.Err() != nil {
			return DeviceChoice{}, ctx.Err()
		}
		if errors.Is(err, ErrCUDADevice) {
			return DeviceChoice{Variant: "cpu", Device: "cpu", FallbackReason: err.Error()}, nil
		}
		return DeviceChoice{}, err
	}
	return DeviceChoice{Variant: "cuda", Device: "cuda"}, nil
}

func ShouldRetryOnCPU(err, contextErr error, priorRetries int) bool {
	return contextErr == nil && priorRetries == 0 && errors.Is(err, ErrCUDADevice)
}

func ClassifyWorkerExit(exitCode int, message string) error {
	if exitCode == 42 {
		return fmt.Errorf("%w: %s", ErrCUDADevice, message)
	}
	return errors.New(message)
}
