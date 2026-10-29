"""Stable worker exit classification for a one-time CUDA-to-CPU fallback."""

from __future__ import annotations

CUDA_DEVICE_EXIT_CODE = 42

_CUDA_DEVICE_MARKERS = (
    "cuda error",
    "cuda out of memory",
    "no cuda gpu",
    "没有可用的 cuda gpu",
    "no nvidia driver",
    "cuda driver version is insufficient",
    "not compiled with cuda enabled",
    "no kernel image is available",
    "cudnn error",
)


def is_cuda_device_failure(error: Exception) -> bool:
    if not isinstance(error, RuntimeError):
        return False
    message = str(error).lower()
    return any(marker in message for marker in _CUDA_DEVICE_MARKERS)
