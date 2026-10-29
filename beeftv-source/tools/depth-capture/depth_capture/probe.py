"""End-to-end runtime probe used before enabling a new device variant."""

from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys

from .cli import build_parser, run
from .device_failure import CUDA_DEVICE_EXIT_CODE, is_cuda_device_failure
from .pipeline import VideoMetadata, probe_video


def validate_preview_contract(source: Path, preview: Path) -> VideoMetadata:
    original = probe_video(source)
    result = probe_video(preview)
    if (result.width, result.height) != (1920, 1080):
        raise ValueError("深度预览分辨率不符合标准配置")
    if result.frames != original.frames:
        raise ValueError(f"深度预览帧数不匹配：{result.frames} != {original.frames}")
    if abs(result.duration - original.duration) > 1 / original.fps:
        raise ValueError("深度预览时长与输入不匹配")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(preview), "-f", "null", "-"],
        check=True,
        capture_output=True,
    )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="验证 BeefTV 深度运行包的真实模型推理")
    parser.add_argument("--device", choices=("cpu", "cuda"), required=True)
    parser.add_argument("--runtime-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    args = parser.parse_args()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    source = args.work_dir / "probe-source.mp4"
    output_dir = args.work_dir / "output"
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=black:size=64x48:rate=5:duration=0.4",
            "-pix_fmt", "yuv420p", str(source),
        ],
        check=True,
    )
    worker_args = build_parser().parse_args(
        [
            str(source), "--output-dir", str(output_dir),
            "--runtime-dir", str(args.runtime_dir), "--device", args.device,
            "--input-size", "280", "--max-resolution", "960",
            "--output-resolution", "1920x1080", "--max-seconds", "15",
        ]
    )
    try:
        run(worker_args)
    except RuntimeError as error:
        if args.device != "cuda" or not is_cuda_device_failure(error):
            raise
        print(f"CUDA 真实前向不可用：{error}", file=sys.stderr)
        return CUDA_DEVICE_EXIT_CODE
    preview = output_dir / "probe-source_depth_preview.mp4"
    metadata = validate_preview_contract(source, preview)
    print(f"PROBE_OK device={args.device} frames={metadata.frames} duration={metadata.duration:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
