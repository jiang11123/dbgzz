from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

try:
    from depth_capture.probe import validate_preview_contract  # noqa: E402
except ModuleNotFoundError:
    def validate_preview_contract(*_args: object) -> None:
        raise AssertionError("深度短片探针缺少输出校验实现")


def make_video(path: Path, *, fps: int, duration: float, width: int, height: int) -> None:
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=black:size={width}x{height}:rate={fps}:duration={duration}",
            "-pix_fmt", "yuv420p", str(path),
        ],
        check=True,
    )


class WindowsDepthProbeTests(unittest.TestCase):
    def test_accepts_a_decodable_preview_with_matching_frames_and_duration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            preview = Path(directory) / "preview.mp4"
            make_video(source, fps=5, duration=0.4, width=64, height=48)
            make_video(preview, fps=5, duration=0.4, width=1920, height=1080)

            metadata = validate_preview_contract(source, preview)

        self.assertEqual((metadata.width, metadata.height), (1920, 1080))
        self.assertEqual(metadata.frames, 2)
        self.assertAlmostEqual(metadata.duration, 0.4, places=2)

    def test_rejects_a_preview_with_missing_frames(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            preview = Path(directory) / "preview.mp4"
            make_video(source, fps=5, duration=0.4, width=64, height=48)
            make_video(preview, fps=5, duration=0.2, width=1920, height=1080)

            with self.assertRaisesRegex(ValueError, "帧数"):
                validate_preview_contract(source, preview)

    def test_rejects_an_undecodable_preview(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            preview = Path(directory) / "preview.mp4"
            make_video(source, fps=5, duration=0.4, width=64, height=48)
            preview.write_bytes(b"not a video")

            with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                validate_preview_contract(source, preview)


if __name__ == "__main__":
    unittest.main()
