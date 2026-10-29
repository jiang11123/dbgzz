from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
import json
from pathlib import Path
import subprocess

import numpy as np


@dataclass(frozen=True)
class VideoMetadata:
    width: int
    height: int
    fps: float
    frames: int
    duration: float


def probe_video(path: Path) -> VideoMetadata:
    completed = subprocess.run(
        [
            "ffprobe",
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,avg_frame_rate,nb_frames:format=duration",
            "-of", "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    if not payload.get("streams"):
        raise ValueError("输入文件不包含视频流")
    stream = payload["streams"][0]
    duration = float(payload.get("format", {}).get("duration") or 0)
    fps = float(Fraction(stream.get("avg_frame_rate") or "0/1"))
    frames = int(stream.get("nb_frames") or round(duration * fps))
    return VideoMetadata(
        width=int(stream["width"]),
        height=int(stream["height"]),
        fps=fps,
        frames=frames,
        duration=duration,
    )


def encode_depth_preview(
    frames: np.ndarray,
    output_path: Path,
    *,
    fps: float,
    width: int,
    height: int,
    crf: int = 18,
) -> None:
    values = np.asarray(frames)
    if values.ndim != 3 or values.dtype != np.uint8 or not values.size:
        raise ValueError("预览帧必须是非空的 uint8 [frames, height, width] 数组")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    input_height, input_width = values.shape[1:]
    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pixel_format", "gray",
        "-video_size", f"{input_width}x{input_height}",
        "-framerate", f"{fps:.6f}", "-i", "-",
        "-vf", f"scale={width}:{height}:flags=bicubic",
        "-an", "-c:v", "libx264", "-crf", str(crf),
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_path),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        process.stdin.write(values.tobytes(order="C"))
        process.stdin.close()
        return_code = process.wait()
    except BaseException:
        process.kill()
        process.wait()
        raise
    if return_code != 0:
        raise RuntimeError(f"FFmpeg 编码失败，退出码 {return_code}")


def validate_input(metadata: VideoMetadata, max_seconds: float) -> None:
    if metadata.duration <= 0 or metadata.frames <= 0 or metadata.fps <= 0:
        raise ValueError("输入视频缺少有效的视频帧或时间信息")
    # Match the application's 100 ms container-metadata tolerance, including
    # low-frame-rate inputs where a whole-frame tolerance could add seconds.
    if metadata.duration > max_seconds + 0.1:
        raise ValueError(f"视频超过 {max_seconds:g} 秒，请先剪辑缩短")


def build_output_paths(output_dir: Path, input_path: Path) -> tuple[Path, Path]:
    stem = input_path.stem
    return (
        output_dir / f"{stem}_depth_preview.mp4",
        output_dir / f"{stem}_depth_raw.npz",
    )


def normalize_depth_clip(
    depths: np.ndarray,
    *,
    low_percentile: float = 2.0,
    high_percentile: float = 98.0,
    near_is_high: bool = True,
    gamma: float = 1.0,
) -> np.ndarray:
    values = np.asarray(depths, dtype=np.float32)
    if values.ndim != 3 or not values.size:
        raise ValueError("深度数据必须是非空的 [frames, height, width] 数组")
    if not 0 <= low_percentile < high_percentile <= 100:
        raise ValueError("深度百分位必须满足 0 <= low < high <= 100")
    if gamma <= 0:
        raise ValueError("gamma 必须大于 0")

    low, high = np.percentile(values, [low_percentile, high_percentile])
    if not np.isfinite(low) or not np.isfinite(high) or high <= low:
        return np.zeros(values.shape, dtype=np.uint8)

    normalized = np.clip((values - low) / (high - low), 0.0, 1.0)
    if not near_is_high:
        normalized = 1.0 - normalized
    normalized = np.power(normalized, gamma)
    return np.rint(normalized * 255.0).astype(np.uint8)
