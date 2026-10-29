from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time

import numpy as np

from .model import default_runtime_dir, infer_relative_depth, select_device
from .device_failure import CUDA_DEVICE_EXIT_CODE, is_cuda_device_failure
from .pipeline import (
    build_output_paths,
    encode_depth_preview,
    normalize_depth_clip,
    probe_video,
    validate_input,
)


def parse_resolution(value: str, source_width: int, source_height: int) -> tuple[int, int]:
    if value == "source":
        return source_width, source_height
    try:
        width_text, height_text = value.lower().split("x", 1)
        width, height = int(width_text), int(height_text)
    except (TypeError, ValueError) as error:
        raise ValueError("输出分辨率必须是 source 或 WIDTHxHEIGHT") from error
    if width <= 0 or height <= 0 or width % 2 or height % 2:
        raise ValueError("输出宽高必须是正偶数")
    return width, height


def standard_target_fps(source_fps: float) -> float:
    """Keep ordinary clips unchanged while bounding the standard profile at 30fps."""
    return min(source_fps, 30.0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="将普通视频转换成稳定的灰度深度动作参考视频")
    parser.add_argument("input", type=Path, help="输入视频")
    parser.add_argument("--output-dir", type=Path, required=True, help="输出目录")
    parser.add_argument("--runtime-dir", type=Path, default=default_runtime_dir(), help="官方模型代码和权重缓存目录")
    parser.add_argument("--device", choices=["auto", "mps", "cuda", "cpu"], default="auto")
    parser.add_argument("--input-size", type=int, default=280, help="模型推理尺寸；MPS MVP 默认 280")
    parser.add_argument("--max-resolution", type=int, default=960, help="推理前输入视频最大边")
    parser.add_argument("--output-resolution", default="1920x1080", help="source 或 WIDTHxHEIGHT")
    parser.add_argument("--max-seconds", type=float, default=15.0)
    parser.add_argument("--low-percentile", type=float, default=2.0)
    parser.add_argument("--high-percentile", type=float, default=98.0)
    parser.add_argument("--gamma", type=float, default=1.25)
    parser.add_argument("--save-raw", action="store_true", help="额外保存 float32 NPZ 深度数据")
    return parser


def run(args: argparse.Namespace) -> dict[str, object]:
    input_path = args.input.expanduser().resolve()
    if not input_path.is_file():
        raise FileNotFoundError(f"找不到输入视频：{input_path}")
    metadata = probe_video(input_path)
    validate_input(metadata, args.max_seconds)
    output_width, output_height = parse_resolution(
        args.output_resolution, metadata.width, metadata.height
    )
    preview_path, raw_path = build_output_paths(args.output_dir.expanduser().resolve(), input_path)
    device, _ = select_device(args.device)
    print(f"[1/3] 输入 {metadata.width}x{metadata.height} · {metadata.fps:.3f}fps · {metadata.frames} 帧")
    print(f"[2/3] Video Depth Anything Small · device={device} · input_size={args.input_size}")
    started = time.monotonic()
    depths, output_fps = infer_relative_depth(
        input_path,
        runtime_dir=args.runtime_dir.expanduser().resolve(),
        device=device,
        input_size=args.input_size,
        max_resolution=args.max_resolution,
        target_fps=standard_target_fps(metadata.fps),
    )
    preview_frames = normalize_depth_clip(
        depths,
        low_percentile=args.low_percentile,
        high_percentile=args.high_percentile,
        near_is_high=True,
        gamma=args.gamma,
    )
    print(f"[3/3] 编码 {output_width}x{output_height} 灰度预览")
    encode_depth_preview(
        preview_frames,
        preview_path,
        fps=output_fps,
        width=output_width,
        height=output_height,
    )
    if args.save_raw:
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(raw_path, depths=depths, fps=np.float32(output_fps))
    result = {
        "input": str(input_path),
        "preview": str(preview_path),
        "raw": str(raw_path) if args.save_raw else None,
        "device": device,
        "frames": int(depths.shape[0]),
        "fps": output_fps,
        "seconds": round(time.monotonic() - started, 3),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def main() -> int:
    args = build_parser().parse_args()
    try:
        run(args)
    except RuntimeError as error:
        if args.device != "cuda" or not is_cuda_device_failure(error):
            raise
        print(f"CUDA 设备故障：{error}", file=sys.stderr)
        return CUDA_DEVICE_EXIT_CODE
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
