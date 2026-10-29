from __future__ import annotations

import importlib
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import zipfile

import cv2
import numpy as np


VDA_REPOSITORY = "https://github.com/DepthAnything/Video-Depth-Anything.git"
VDA_COMMIT = "4f5ae23172ba60fd7bc11ef671cca678842c7072"
VDA_SMALL_WEIGHTS = (
    "https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/main/"
    "video_depth_anything_vits.pth"
)
VDA_SMALL_SHA256 = "13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609"


def default_runtime_dir() -> Path:
    configured = os.environ.get("BEEFTV_DEPTH_RUNTIME")
    # Keep the runtime beside this project so it survives /tmp cleanup and
    # can be reused by the local app on every launch.
    project_cache = Path(__file__).resolve().parents[1] / ".cache" / "runtime"
    return Path(configured).expanduser() if configured else project_cache


def _valid_checkpoint(path: Path) -> bool:
    """Reject partial downloads before they can be used by torch.load."""
    if not path.is_file() or path.stat().st_size < 10_000_000:
        return False
    try:
        if not zipfile.is_zipfile(path) or zipfile.ZipFile(path).testzip() is not None:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest() == VDA_SMALL_SHA256
    except (OSError, zipfile.BadZipFile):
        return False


def _download_checkpoint(checkpoint: Path) -> None:
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    temporary = checkpoint.with_suffix(".download")
    subprocess.run(
        [
            "curl", "--fail", "--location", "--retry", "3", "--retry-delay", "3",
            "--connect-timeout", "20", "--max-time", "1800", "--output", str(temporary),
            VDA_SMALL_WEIGHTS,
        ],
        check=True,
    )
    if not _valid_checkpoint(temporary):
        temporary.replace(checkpoint.with_suffix(".corrupt"))
        raise RuntimeError("模型权重下载不完整，已保存为 .corrupt，不会被继续使用")
    temporary.replace(checkpoint)


def ensure_vda_runtime(runtime_dir: Path) -> tuple[Path, Path]:
    configured_source = os.environ.get("BEEFTV_VDA_SOURCE")
    repo_dir = Path(configured_source).expanduser() if configured_source else runtime_dir / "Video-Depth-Anything"
    checkpoint = runtime_dir / "checkpoints" / "video_depth_anything_vits.pth"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    if configured_source:
        if not (repo_dir / "video_depth_anything" / "video_depth.py").is_file():
            raise RuntimeError("深度组件缺少固定版本的 Video Depth Anything 源码")
    elif not (repo_dir / ".git").exists():
        subprocess.run(["git", "clone", VDA_REPOSITORY, str(repo_dir)], check=True)
        subprocess.run(["git", "-C", str(repo_dir), "checkout", VDA_COMMIT], check=True)
    if not _valid_checkpoint(checkpoint):
        if checkpoint.exists():
            checkpoint.replace(checkpoint.with_suffix(".corrupt"))
        _download_checkpoint(checkpoint)
    return repo_dir, checkpoint


def select_device(requested: str = "auto") -> tuple[str, bool]:
    import torch

    if requested != "auto":
        if requested == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("当前环境没有可用的 CUDA GPU")
        if requested == "mps" and not torch.backends.mps.is_available():
            raise RuntimeError("当前环境没有可用的 Apple Metal GPU")
        return requested, requested != "cuda"
    if torch.cuda.is_available():
        return "cuda", False
    if torch.backends.mps.is_available():
        return "mps", True
    return "cpu", True


def infer_relative_depth(
    input_path: Path,
    *,
    runtime_dir: Path,
    device: str,
    input_size: int,
    max_resolution: int,
    target_fps: float = -1,
    max_frames: int = -1,
) -> tuple[np.ndarray, float]:
    import torch

    repo_dir, checkpoint = ensure_vda_runtime(runtime_dir)
    sys.path.insert(0, str(repo_dir))
    try:
        video_depth_module = importlib.import_module("video_depth_anything.video_depth")
        utilities = importlib.import_module("utils.dc_utils")
        model_class = video_depth_module.VideoDepthAnything
        frames, fps = utilities.read_video_frames(
            str(input_path), max_frames, target_fps, max_resolution
        )
        model = model_class(
            encoder="vits",
            features=64,
            out_channels=[48, 96, 192, 384],
        )
        model.load_state_dict(torch.load(checkpoint, map_location="cpu"), strict=True)
        model = model.to(device).eval()
        fp32 = device != "cuda"
        depths, output_fps = model.infer_video_depth(
            frames,
            fps,
            input_size=input_size,
            device=device,
            fp32=fp32,
        )
        return np.asarray(depths, dtype=np.float32), float(output_fps)
    finally:
        if sys.path and sys.path[0] == str(repo_dir):
            sys.path.pop(0)


def infer_relative_depth_streaming(
    input_path: Path,
    *,
    runtime_dir: Path,
    device: str,
    input_size: int,
    max_resolution: int,
    fp32: bool = True,
) -> tuple[np.ndarray, float]:
    """Run the official streaming model while decoding one frame at a time."""
    import torch

    repo_dir, checkpoint = ensure_vda_runtime(runtime_dir)
    sys.path.insert(0, str(repo_dir))
    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        raise RuntimeError(f"无法打开视频：{input_path}")
    try:
        stream_module = importlib.import_module("video_depth_anything.video_depth_stream")
        model = stream_module.VideoDepthAnything(
            encoder="vits",
            features=64,
            out_channels=[48, 96, 192, 384],
        )
        model.load_state_dict(torch.load(checkpoint, map_location="cpu"), strict=True)
        model = model.to(device).eval()
        source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 30.0)
        source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if max_resolution > 0 and max(source_width, source_height) > max_resolution:
            scale = max_resolution / max(source_width, source_height)
            target_width = round(source_width * scale)
            target_height = round(source_height * scale)
        else:
            target_width, target_height = source_width, source_height

        depths: list[np.ndarray] = []
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            if (target_width, target_height) != (source_width, source_height):
                frame = cv2.resize(frame, (target_width, target_height), interpolation=cv2.INTER_AREA)
            with torch.inference_mode():
                depth = model.infer_video_depth_one(
                    frame,
                    input_size=input_size,
                    device=device,
                    fp32=fp32,
                )
            depths.append(np.asarray(depth, dtype=np.float32))
        if not depths:
            raise ValueError("输入视频没有可读取的帧")
        return np.stack(depths, axis=0), source_fps
    finally:
        capture.release()
        if sys.path and sys.path[0] == str(repo_dir):
            sys.path.pop(0)
