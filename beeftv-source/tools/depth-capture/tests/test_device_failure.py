from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from depth_capture.device_failure import is_cuda_device_failure  # noqa: E402


class CUDAFailureTests(unittest.TestCase):
    def test_only_known_device_errors_request_cpu_fallback(self) -> None:
        for message in (
            "CUDA error: invalid device function",
            "CUDA out of memory",
            "Found no NVIDIA driver on your system",
            "Torch not compiled with CUDA enabled",
            "当前环境没有可用的 CUDA GPU",
        ):
            with self.subTest(message=message):
                self.assertTrue(is_cuda_device_failure(RuntimeError(message)))
        for message in (
            "SHA-256 校验失败",
            "输入视频缺少有效帧",
            "No space left on device",
            "FFmpeg 编码失败",
        ):
            with self.subTest(message=message):
                self.assertFalse(is_cuda_device_failure(RuntimeError(message)))


if __name__ == "__main__":
    unittest.main()
