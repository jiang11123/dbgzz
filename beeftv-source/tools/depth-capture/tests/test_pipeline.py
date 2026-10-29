from __future__ import annotations

import sys
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

from depth_capture.pipeline import (  # noqa: E402
    VideoMetadata,
    build_output_paths,
    encode_depth_preview,
    normalize_depth_clip,
    probe_video,
    validate_input,
)
from depth_capture.cli import standard_target_fps  # noqa: E402


class NormalizeDepthClipTests(unittest.TestCase):
    def test_normalizes_the_whole_clip_instead_of_each_frame(self) -> None:
        depths = np.array(
            [
                [[0.0, 5.0, 10.0]],
                [[0.0, 5.0, 20.0]],
            ],
            dtype=np.float32,
        )

        result = normalize_depth_clip(depths, low_percentile=0, high_percentile=100)

        self.assertEqual(result.dtype, np.uint8)
        self.assertEqual(int(result[0, 0, 1]), int(result[1, 0, 1]))
        self.assertEqual(int(result.min()), 0)
        self.assertEqual(int(result.max()), 255)

    def test_inverts_depth_when_model_uses_far_as_larger_value(self) -> None:
        depths = np.array([[[1.0, 2.0, 3.0]]], dtype=np.float32)

        result = normalize_depth_clip(
            depths,
            low_percentile=0,
            high_percentile=100,
            near_is_high=False,
        )

        self.assertGreater(int(result[0, 0, 0]), int(result[0, 0, 2]))


class InputContractTests(unittest.TestCase):
    def test_standard_profile_caps_high_frame_rate_video_at_30fps(self) -> None:
        self.assertEqual(standard_target_fps(60.0), 30.0)
        self.assertEqual(standard_target_fps(24.0), 24.0)

    def test_rejects_a_video_longer_than_the_mvp_limit(self) -> None:
        metadata = VideoMetadata(width=1280, height=720, fps=30.0, frames=454, duration=15.134)

        with self.assertRaisesRegex(ValueError, "15"):
            validate_input(metadata, max_seconds=15.0)

    def test_duration_tolerance_does_not_expand_at_low_frame_rates(self) -> None:
        for fps in (1.0, 24.0, 30.0, 60.0):
            with self.subTest(fps=fps):
                validate_input(VideoMetadata(1280, 720, fps, round(15 * fps), 15.1), 15.0)
                with self.assertRaisesRegex(ValueError, "15"):
                    validate_input(VideoMetadata(1280, 720, fps, round(16 * fps), 16.0), 15.0)

    def test_builds_preview_and_raw_depth_paths(self) -> None:
        preview, raw = build_output_paths(Path("/tmp/out"), Path("dance.mp4"))

        self.assertEqual(preview, Path("/tmp/out/dance_depth_preview.mp4"))
        self.assertEqual(raw, Path("/tmp/out/dance_depth_raw.npz"))

    def test_probes_real_video_metadata_with_ffprobe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "fixture.mp4"
            subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "color=black:size=64x48:rate=10:duration=0.4",
                    "-pix_fmt", "yuv420p", str(video),
                ],
                check=True,
            )

            metadata = probe_video(video)

        self.assertEqual((metadata.width, metadata.height), (64, 48))
        self.assertAlmostEqual(metadata.fps, 10.0)
        self.assertEqual(metadata.frames, 4)
        self.assertAlmostEqual(metadata.duration, 0.4, places=2)

    def test_encodes_a_grayscale_preview_with_requested_geometry(self) -> None:
        depths = np.stack(
            [
                np.zeros((8, 8), dtype=np.uint8),
                np.full((8, 8), 255, dtype=np.uint8),
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "preview.mp4"

            encode_depth_preview(depths, output, fps=5.0, width=64, height=48)
            metadata = probe_video(output)

        self.assertEqual((metadata.width, metadata.height), (64, 48))
        self.assertAlmostEqual(metadata.fps, 5.0)
        self.assertEqual(metadata.frames, 2)


if __name__ == "__main__":
    unittest.main()
