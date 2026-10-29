import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { assertUsableSegmentOutput, buildRemoveAudioArgs, MUTED_VIDEO_OUTPUT_NAME, SEGMENT_INPUT_NAME } from "../src/lib/canvas/canvas-video-segment-args";

const QA_SOURCE = process.env.BEEFTV_SEGMENT_QA_MP4 || "";

function commandExists(name: string) {
    const result = spawnSync(name, ["-version"], { encoding: "utf8" });
    return result.status === 0;
}

const hasFfmpeg = commandExists("ffmpeg") && commandExists("ffprobe");

function runFfmpeg(cwd: string, args: string[]) {
    const result = spawnSync("ffmpeg", ["-y", ...args], { cwd, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(result.stderr || `ffmpeg exited ${result.status}`);
    }
}

function probe(path: string) {
    const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,nb_streams:stream=codec_type,codec_name,nb_frames", "-of", "json", path], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || "ffprobe failed");
    return JSON.parse(result.stdout) as { streams?: Array<{ codec_type?: string; codec_name?: string; nb_frames?: string }>; format?: { duration?: string; nb_streams?: string | number } };
}

function makeLongGopFixture(dir: string) {
    const path = join(dir, "fixture-long-gop.mp4");
    runFfmpeg(dir, ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=4", "-c:v", "libx264", "-g", "48", "-keyint_min", "48", "-pix_fmt", "yuv420p", "-output_ts_offset", "1.25", "-an", path]);
    return path;
}

describe.skipIf(!hasFfmpeg)("remove-audio ffmpeg args on real media", () => {
    test("full-source copy of a long-GOP video-only fixture keeps a decodable stream", () => {
        const dir = mkdtempSync(join(tmpdir(), "beeftv-segment-"));
        try {
            copyFileSync(makeLongGopFixture(dir), join(dir, SEGMENT_INPUT_NAME));
            runFfmpeg(dir, buildRemoveAudioArgs("0", "4", MUTED_VIDEO_OUTPUT_NAME, { fullSource: true }));
            const output = join(dir, MUTED_VIDEO_OUTPUT_NAME);
            const bytes = readFileSync(output);
            assertUsableSegmentOutput(bytes, "video");
            const info = probe(output);
            expect(Number(info.format?.nb_streams)).toBeGreaterThan(0);
            expect(info.streams?.some((stream) => stream.codec_type === "video" && stream.codec_name === "h264")).toBe(true);
            expect(Number(info.format?.duration)).toBeGreaterThan(3);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("partial range re-encodes instead of emitting an empty copy", () => {
        const dir = mkdtempSync(join(tmpdir(), "beeftv-segment-"));
        try {
            copyFileSync(makeLongGopFixture(dir), join(dir, SEGMENT_INPUT_NAME));
            runFfmpeg(dir, buildRemoveAudioArgs("1", "1.25"));
            const output = join(dir, MUTED_VIDEO_OUTPUT_NAME);
            assertUsableSegmentOutput(readFileSync(output), "video");
            const info = probe(output);
            expect(info.streams?.some((stream) => stream.codec_type === "video")).toBe(true);
            const duration = Number(info.format?.duration);
            expect(duration).toBeGreaterThan(1);
            expect(duration).toBeLessThan(1.6);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("tiny valid clip under 4KiB is accepted and still has a video sample", () => {
        const dir = mkdtempSync(join(tmpdir(), "beeftv-segment-tiny-"));
        try {
            const tiny = join(dir, "tiny.mp4");
            runFfmpeg(dir, ["-f", "lavfi", "-i", "testsrc=size=16x16:rate=25:duration=0.04", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", tiny]);
            const sourceBytes = readFileSync(tiny);
            expect(sourceBytes.byteLength).toBeLessThan(4096);
            assertUsableSegmentOutput(sourceBytes, "video");
            copyFileSync(tiny, join(dir, SEGMENT_INPUT_NAME));
            runFfmpeg(dir, buildRemoveAudioArgs("0", "0.04", MUTED_VIDEO_OUTPUT_NAME, { fullSource: true }));
            const output = join(dir, MUTED_VIDEO_OUTPUT_NAME);
            const bytes = readFileSync(output);
            expect(bytes.byteLength).toBeLessThan(4096);
            assertUsableSegmentOutput(bytes, "video");
            const info = probe(output);
            expect(info.streams?.some((stream) => stream.codec_type === "video")).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test.skipIf(!QA_SOURCE)("optional BEEFTV_SEGMENT_QA_MP4 full-source mute keeps a video stream", () => {
        if (!existsSync(QA_SOURCE)) throw new Error(`BEEFTV_SEGMENT_QA_MP4 指向的文件不存在`);
        const dir = mkdtempSync(join(tmpdir(), "beeftv-segment-qa-"));
        try {
            copyFileSync(QA_SOURCE, join(dir, SEGMENT_INPUT_NAME));
            runFfmpeg(dir, buildRemoveAudioArgs("0", "1", MUTED_VIDEO_OUTPUT_NAME, { fullSource: true }));
            const output = join(dir, MUTED_VIDEO_OUTPUT_NAME);
            const bytes = readFileSync(output);
            assertUsableSegmentOutput(bytes, "video");
            const info = probe(output);
            expect(info.streams?.some((stream) => stream.codec_type === "video")).toBe(true);
            expect(Number(info.format?.duration)).toBeGreaterThan(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
